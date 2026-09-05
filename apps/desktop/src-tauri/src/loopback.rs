use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use wasapi::*;

// Raises the process-wide timer resolution so Sleep() calls (including the
// poll loop below) actually honor short durations instead of being
// coalesced to a coarser OS-chosen granularity. Standard practice for
// real-time audio/video apps on Windows. Didn't turn out to be the fix for
// the throughput bug documented on BUFFER_DURATION_HNS below (measured no
// change), but costs nothing and is worth keeping as insurance on hardware
// where coalescing genuinely is a factor. Must be paired with
// timeEndPeriod at the same resolution when done, or the OS keeps the
// system-wide high-resolution timer active indefinitely.
#[link(name = "winmm")]
extern "system" {
    fn timeBeginPeriod(uPeriod: u32) -> u32;
    fn timeEndPeriod(uPeriod: u32) -> u32;
}
const TIMER_RESOLUTION_MS: u32 = 1;

const POLL_INTERVAL: Duration = Duration::from_millis(10);
/// A 200ms buffer here (paired with a 50ms poll interval) measured a real,
/// severe bug: `read_from_device_to_deque` delivered only ~1/5 of the
/// expected byte rate (76800 B/s instead of the correct 384000 B/s for this
/// device's 48kHz/stereo/float32 format), silently dropping ~80% of the
/// audio before this capture thread ever saw it — the actual root cause of
/// interviewer speech coming through unrecognizable, not a VAD/model
/// problem. Shrinking the buffer to 40ms with a 10ms poll interval restored
/// real-time throughput (measured ~365000 B/s, within noise of correct).
/// The exact mechanism (why a larger shared-mode buffer caused data loss
/// instead of just added latency) wasn't root-caused further — this value
/// is empirically verified correct on this hardware, not derived from
/// WASAPI documentation. If loopback audio ever sounds thin/dropped again
/// on different hardware, set LOOPBACK_VAD_DEBUG=1 and check
/// `[loopback-read] bytes_read_last_report` against
/// `sample_rate * blockalign` before assuming it's a VAD/model issue again.
const BUFFER_DURATION_HNS: i64 = 400_000;

/// Simple energy-based voice activity detection so speech segments end at
/// natural pauses instead of an arbitrary fixed-duration boundary. Fixed
/// windows were cutting words mid-syllable (hurting Whisper accuracy) and
/// forcing every segment to wait out the full window even when the speaker
/// had already stopped talking (hurting latency) — both were the same root
/// cause. RMS threshold on 32-bit float PCM; not a learned VAD model, but
/// sufficient to detect a genuine pause vs. mid-sentence breath.
const SILENCE_RMS_THRESHOLD: f32 = 0.006;
/// How long a sustained silence must last before a segment is flushed. Long
/// enough to survive natural mid-sentence pauses/breaths, short enough that
/// the candidate isn't kept waiting once the interviewer actually stops.
const SILENCE_HANG_MS: u64 = 450;
/// Segments are flushed at this length regardless of silence, so a run-on
/// sentence with no pause doesn't withhold transcription indefinitely.
const MAX_SEGMENT_SECS: f32 = 12.0;
/// Below this, a "segment" is almost certainly noise/silence bleed, not
/// speech — don't bother sending it to Whisper.
const MIN_SEGMENT_SECS: f32 = 0.35;
/// Analysis frame size for RMS/silence detection.
const VAD_FRAME_MS: u64 = 20;
/// How much audio immediately before a detected speech onset gets prepended
/// to the segment. Confirmed by testing: a two-clause question played after
/// a period of silence ("Have you ever reviewed AI-generated code before?
/// What did that involve?") lost the entire first clause even in isolation,
/// with no other question nearby — the RMS crossing into "speech" doesn't
/// happen at the true start of the word (a soft onset ramps up gradually,
/// and the loudest energy often lands a syllable or two in), so without a
/// pre-roll the first ~1 syllable-or-more of every utterance-after-silence
/// is silently dropped before VAD ever notices speech started.
const PRE_ROLL_MS: u64 = 300;

/// Captures system loopback audio (what's playing through the default
/// output device — e.g. the interviewer's voice over a video call) and
/// invokes `on_chunk` with WAV-encoded bytes for each detected speech
/// segment (silence-terminated, not a fixed clock), until `stop_flag` is
/// set. Blocking — call from a dedicated thread, not the async runtime.
///
/// Internally also runs a silent-render keepalive stream for as long as
/// capture runs: WASAPI's audio engine can go idle when nothing is
/// actively rendering, and loopback capture on an idle engine silently
/// stops delivering packets (observed directly: capture succeeded at every
/// API call but returned exactly 0 frames, indefinitely, until a
/// concurrent render stream — even one outputting pure silence — was
/// added). This is undocumented behavior discovered through testing, not
/// something the wasapi crate or Microsoft's docs call out explicitly.
pub fn run_loopback_capture(
    stop_flag: Arc<AtomicBool>,
    mut on_chunk: impl FnMut(Vec<u8>),
) -> Result<(), String> {
    // SAFETY: timeBeginPeriod/timeEndPeriod is a plain winmm.dll call with
    // no preconditions beyond matching the begin/end resolution, which the
    // guard below guarantees even on early return via `?`.
    unsafe {
        timeBeginPeriod(TIMER_RESOLUTION_MS);
    }
    struct TimerResolutionGuard;
    impl Drop for TimerResolutionGuard {
        fn drop(&mut self) {
            unsafe {
                timeEndPeriod(TIMER_RESOLUTION_MS);
            }
        }
    }
    let _timer_guard = TimerResolutionGuard;

    let keepalive_stop = stop_flag.clone();
    let keepalive_handle = thread::spawn(move || {
        if let Err(e) = run_silence_keepalive(keepalive_stop) {
            log::warn!("[loopback] silence keepalive stream failed: {e}");
        }
    });

    let result = run_loopback_capture_inner(stop_flag, &mut on_chunk);

    let _ = keepalive_handle.join();
    result
}

fn run_loopback_capture_inner(
    stop_flag: Arc<AtomicBool>,
    on_chunk: &mut impl FnMut(Vec<u8>),
) -> Result<(), String> {
    initialize_mta()
        .ok()
        .map_err(|e| format!("COM init failed: {e:?}"))?;

    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    // Direction::Render gets the default *output* device — the loopback
    // switch is initializing the client with Direction::Capture below
    // while the device itself is a render endpoint.
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| e.to_string())?;
    let mut audio_client = device.get_iaudioclient().map_err(|e| e.to_string())?;

    // Loopback (shared-mode render) capture must use the device's own mix
    // format ("the format the device uses in shared mode and should always
    // be accepted" per WASAPI docs) — an arbitrary forced format fails with
    // AUDCLNT_E_UNSUPPORTED_FORMAT on render endpoints, unlike microphone
    // (Direction::Capture) devices which tolerate more formats.
    let format = audio_client.get_mixformat().map_err(|e| e.to_string())?;
    let sample_rate = format.get_samplespersec();
    let channels = format.get_nchannels();
    let bits = format.get_bitspersample();
    let blockalign = format.get_blockalign();

    // encode_wav_f32 below assumes 32-bit IEEE float samples — the standard
    // Windows shared-mode engine format — but verify rather than silently
    // mis-decode raw bytes if some device reports otherwise.
    let is_float = matches!(format.get_subformat(), Ok(SampleType::Float));
    if !is_float || bits != 32 {
        return Err(format!(
            "unsupported loopback mix format: bits={bits}, float={is_float} (expected 32-bit float)"
        ));
    }

    // Polling, not event-driven: the event handle never signals for
    // loopback capture on this hardware even with audio actively playing —
    // confirmed by testing. Polling sidesteps depending on that event.
    let mode = StreamMode::PollingShared {
        autoconvert: true,
        buffer_duration_hns: BUFFER_DURATION_HNS,
    };
    audio_client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(|e| format!("initialize_client failed: {e}"))?;

    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| format!("get_audiocaptureclient failed: {e}"))?;

    let vad_frame_frames = ((sample_rate as u64 * VAD_FRAME_MS) / 1000) as usize;
    let vad_frame_bytes = blockalign as usize * vad_frame_frames;
    let mut sample_queue: VecDeque<u8> = VecDeque::with_capacity(vad_frame_bytes * 8);

    let mut segment: Vec<u8> = Vec::new();
    let mut silence_ms_run: u64 = 0;
    let mut has_had_speech = false;
    let max_segment_bytes = blockalign as usize * (sample_rate as f32 * MAX_SEGMENT_SECS) as usize;
    let min_segment_bytes = blockalign as usize * (sample_rate as f32 * MIN_SEGMENT_SECS) as usize;

    // Rolling lookback of the audio immediately preceding a speech onset —
    // see PRE_ROLL_MS's doc comment. Only maintained while waiting for
    // speech to start; drained into `segment` the instant it does.
    let pre_roll_frames = (PRE_ROLL_MS / VAD_FRAME_MS) as usize;
    let pre_roll_max_bytes = vad_frame_bytes * pre_roll_frames;
    let mut pre_roll: VecDeque<u8> = VecDeque::with_capacity(pre_roll_max_bytes);

    // Temporary calibration aid: SILENCE_RMS_THRESHOLD was a guess, and this
    // codebase has been burned before by guessed thresholds that didn't
    // match real measured values (see MATCH_SCORE_THRESHOLD's history).
    // With LOOPBACK_VAD_DEBUG=1 set, print a running min/max RMS window
    // every ~1s so the real threshold can be measured from actual hardware
    // instead of assumed.
    let vad_debug = std::env::var("LOOPBACK_VAD_DEBUG").is_ok();
    let mut debug_min = f32::MAX;
    let mut debug_max = 0f32;
    let mut debug_frames = 0u32;
    let debug_start = std::time::Instant::now();
    let mut debug_last_report = std::time::Instant::now();
    let mut debug_bytes_since_report = 0u64;

    audio_client.start_stream().map_err(|e| e.to_string())?;

    while !stop_flag.load(Ordering::Relaxed) {
        let before_len = sample_queue.len();
        capture_client
            .read_from_device_to_deque(&mut sample_queue)
            .map_err(|e| e.to_string())?;
        let newly_read = sample_queue.len().saturating_sub(before_len);
        if vad_debug {
            debug_bytes_since_report += newly_read as u64;
            if debug_last_report.elapsed().as_millis() >= 1000 {
                log::info!(
                    "[loopback-read] wall_elapsed_total={:.1}s bytes_read_last_report={} over {:.2}s",
                    debug_start.elapsed().as_secs_f32(),
                    debug_bytes_since_report,
                    debug_last_report.elapsed().as_secs_f32()
                );
                debug_bytes_since_report = 0;
                debug_last_report = std::time::Instant::now();
            }
        }

        while sample_queue.len() >= vad_frame_bytes {
            let frame: Vec<u8> = sample_queue.drain(..vad_frame_bytes).collect();
            let rms = compute_rms_f32(&frame, channels as usize);
            let is_speech = rms >= SILENCE_RMS_THRESHOLD;

            if vad_debug {
                debug_min = debug_min.min(rms);
                debug_max = debug_max.max(rms);
                debug_frames += 1;
                if debug_frames >= (1000 / VAD_FRAME_MS) as u32 {
                    log::info!(
                        "[loopback-vad] rms min={debug_min:.6} max={debug_max:.6} threshold={SILENCE_RMS_THRESHOLD:.6}"
                    );
                    debug_min = f32::MAX;
                    debug_max = 0f32;
                    debug_frames = 0;
                }
            }

            if is_speech {
                if !has_had_speech {
                    // Onset: prepend whatever we were holding in the
                    // lookback buffer so the segment includes the audio
                    // right before VAD noticed speech, not just from the
                    // frame that crossed the threshold.
                    segment.extend(pre_roll.iter().copied());
                    pre_roll.clear();
                }
                silence_ms_run = 0;
                has_had_speech = true;
                segment.extend_from_slice(&frame);
            } else if has_had_speech {
                // Keep a little trailing silence in the segment (natural
                // cadence) rather than clipping the instant speech stops.
                segment.extend_from_slice(&frame);
                silence_ms_run += VAD_FRAME_MS;
            } else {
                // Silence before any speech has started this segment:
                // don't add it to the segment (would waste buffer/latency
                // on dead air), but keep a short rolling lookback in case
                // speech starts within the next PRE_ROLL_MS.
                pre_roll.extend(frame.iter().copied());
                while pre_roll.len() > pre_roll_max_bytes {
                    let excess = pre_roll.len() - pre_roll_max_bytes;
                    pre_roll.drain(..excess);
                }
            }

            let should_flush = has_had_speech
                && (silence_ms_run >= SILENCE_HANG_MS || segment.len() >= max_segment_bytes);

            if should_flush {
                if segment.len() >= min_segment_bytes {
                    on_chunk(encode_wav_f32(&segment, sample_rate, channels, bits));
                }
                segment.clear();
                silence_ms_run = 0;
                has_had_speech = false;
            }
        }

        thread::sleep(POLL_INTERVAL);
    }

    // Flush whatever's left (e.g. stop was requested mid-utterance).
    if has_had_speech && segment.len() >= min_segment_bytes {
        on_chunk(encode_wav_f32(&segment, sample_rate, channels, bits));
    }

    let _ = audio_client.stop_stream();
    Ok(())
}

/// Root-mean-square of interleaved 32-bit float PCM, used as a cheap
/// speech/silence discriminator. Not a learned VAD model, but effective
/// enough to find real pauses between spoken phrases.
fn compute_rms_f32(bytes: &[u8], channels: usize) -> f32 {
    let mut sum_sq = 0f64;
    let mut count = 0usize;
    for chunk in bytes.chunks_exact(4 * channels.max(1)) {
        // Average across channels so a signal panned to one side still counts.
        let mut frame_sum = 0f32;
        for c in 0..channels.max(1) {
            let offset = c * 4;
            if offset + 4 <= chunk.len() {
                frame_sum += f32::from_le_bytes([
                    chunk[offset],
                    chunk[offset + 1],
                    chunk[offset + 2],
                    chunk[offset + 3],
                ]);
            }
        }
        let sample = frame_sum / channels.max(1) as f32;
        sum_sq += (sample as f64) * (sample as f64);
        count += 1;
    }
    if count == 0 {
        return 0.0;
    }
    ((sum_sq / count as f64).sqrt()) as f32
}

/// Renders continuous silence to the default output device to keep
/// WASAPI's audio engine actively ticking — see run_loopback_capture's
/// doc comment for why this is necessary.
fn run_silence_keepalive(stop_flag: Arc<AtomicBool>) -> Result<(), String> {
    initialize_mta()
        .ok()
        .map_err(|e| format!("COM init failed: {e:?}"))?;

    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| e.to_string())?;
    let mut audio_client = device.get_iaudioclient().map_err(|e| e.to_string())?;
    let format = audio_client.get_mixformat().map_err(|e| e.to_string())?;
    let blockalign = format.get_blockalign();

    let mode = StreamMode::PollingShared {
        autoconvert: true,
        buffer_duration_hns: BUFFER_DURATION_HNS,
    };
    audio_client
        .initialize_client(&format, &Direction::Render, &mode)
        .map_err(|e| e.to_string())?;
    let render_client = audio_client.get_audiorenderclient().map_err(|e| e.to_string())?;
    audio_client.start_stream().map_err(|e| e.to_string())?;

    while !stop_flag.load(Ordering::Relaxed) {
        let space = audio_client
            .get_available_space_in_frames()
            .map_err(|e| e.to_string())?;
        if space > 0 {
            let mut zeros: VecDeque<u8> = VecDeque::from(vec![0u8; space as usize * blockalign as usize]);
            render_client
                .write_to_device_from_deque(space as usize, &mut zeros, None)
                .map_err(|e| e.to_string())?;
        }
        thread::sleep(POLL_INTERVAL);
    }

    let _ = audio_client.stop_stream();
    Ok(())
}

/// Encodes raw little-endian f32 PCM bytes as a WAV file in memory.
fn encode_wav_f32(raw_f32le_bytes: &[u8], sample_rate: u32, channels: u16, bits: u16) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: bits,
        sample_format: hound::SampleFormat::Float,
    };
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).expect("create wav writer");
        for chunk in raw_f32le_bytes.chunks_exact(4) {
            let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            writer.write_sample(sample).expect("write wav sample");
        }
        writer.finalize().expect("finalize wav");
    }
    cursor.into_inner()
}

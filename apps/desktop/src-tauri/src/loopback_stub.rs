use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// Non-Windows stand-in for `loopback.rs`'s real WASAPI capture. System-audio
/// (interviewer) capture is Windows-only today (see the README's Platform
/// Support section) — this keeps the crate compiling on macOS/Linux and
/// fails the single Tauri command that calls it, which the frontend already
/// treats as non-fatal (`LiveInterviewPage.tsx` falls back to mic-only
/// capture and surfaces "couldn't start: system audio" rather than crashing).
pub fn run_loopback_capture(
    _stop_flag: Arc<AtomicBool>,
    _on_chunk: impl FnMut(Vec<u8>),
) -> Result<(), String> {
    Err(
        "System audio (interviewer) capture isn't implemented on this platform yet — only \
         Windows is currently supported. Mic capture still works. See the README's Platform \
         Support section."
            .to_string(),
    )
}

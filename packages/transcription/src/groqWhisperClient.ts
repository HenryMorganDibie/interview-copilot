export type GroqWhisperOptions = {
  apiKey: string;
  /**
   * whisper-large-v3 (default) is meaningfully more accurate than the
   * -turbo variant on domain-specific/jargon-heavy speech (project names,
   * acronyms like "MVNO" or "SFTP") — worth the small extra latency for the
   * interviewer channel, where a wrong word can misdirect the whole answer.
   */
  model?: string;
  timeoutMs?: number;
  /**
   * Recent transcript text (Whisper's own "prompt" field) — biases decoding
   * toward vocabulary/spelling already seen in this session (e.g. a
   * project name once transcribed correctly is more likely to be
   * transcribed correctly again) and gives continuity across segment
   * boundaries. Whisper only uses the last ~200 tokens of this, so pass
   * recent text, not the whole session.
   */
  contextPrompt?: string;
};

/**
 * Transcribes one audio chunk via Groq's Whisper endpoint. This is a
 * server-side-only client (uses the Groq API key) — never call this from
 * the desktop frontend directly; go through apps/api's /api/transcribe
 * route so the key stays out of the webview.
 */
type VerboseTranscription = {
  text?: string;
  segments?: Array<{
    text: string;
    no_speech_prob?: number;
    avg_logprob?: number;
    compression_ratio?: number;
  }>;
};

/**
 * Whisper is well documented to hallucinate fluent, plausible-sounding
 * sentences on near-silent or very low-energy audio (confirmed directly:
 * a near-silent loopback segment came back as "I think that no English" /
 * "for it is so. I pray that no evil is" — coherent English, zero relation
 * to anything actually said). The RMS-based VAD gate in loopback.rs cuts
 * down how often this happens but can't eliminate it — a genuinely quiet
 * word or a borderline noise floor still gets through sometimes. Whisper
 * itself computes exactly the signals meant to catch this per segment
 * (`no_speech_prob`, `avg_logprob`, `compression_ratio` — the same
 * heuristics faster-whisper/whisper.cpp use to drop hallucinated output),
 * so this uses those instead of inventing a separate confidence check.
 */
function isLikelyHallucinated(segments: VerboseTranscription["segments"]): boolean {
  if (!segments || segments.length === 0) return false;
  let noSpeechSum = 0;
  let logprobSum = 0;
  for (const seg of segments) {
    noSpeechSum += seg.no_speech_prob ?? 0;
    logprobSum += seg.avg_logprob ?? 0;
  }
  const avgNoSpeech = noSpeechSum / segments.length;
  const avgLogprob = logprobSum / segments.length;
  return avgNoSpeech > 0.6 || avgLogprob < -1.0;
}

export async function transcribeAudioChunk(
  audio: Blob,
  filename: string,
  options: GroqWhisperOptions,
): Promise<string> {
  const { apiKey, model = "whisper-large-v3", timeoutMs = 15_000, contextPrompt } = options;

  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", model);
  // verbose_json (not json) so per-segment no_speech_prob/avg_logprob are
  // available to filter hallucinated output — see isLikelyHallucinated.
  form.append("response_format", "verbose_json");
  // Skips language auto-detection (a source of misfires on short/noisy
  // clips) — interviews in this app are English.
  form.append("language", "en");
  if (contextPrompt) {
    form.append("prompt", contextPrompt.slice(-800));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      throw new Error(`Groq transcription failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as VerboseTranscription;
    if (isLikelyHallucinated(data.segments)) return "";
    return data.text?.trim() ?? "";
  } finally {
    clearTimeout(timer);
  }
}

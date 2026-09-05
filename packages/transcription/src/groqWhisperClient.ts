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
export async function transcribeAudioChunk(
  audio: Blob,
  filename: string,
  options: GroqWhisperOptions,
): Promise<string> {
  const { apiKey, model = "whisper-large-v3", timeoutMs = 15_000, contextPrompt } = options;

  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", model);
  form.append("response_format", "json");
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

    const data = (await res.json()) as { text?: string };
    return data.text?.trim() ?? "";
  } finally {
    clearTimeout(timer);
  }
}

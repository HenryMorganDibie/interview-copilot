export type GroqWhisperOptions = {
  apiKey: string;
  /** whisper-large-v3-turbo is faster and cheap; falls back to whisper-large-v3 if unavailable. */
  model?: string;
  timeoutMs?: number;
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
  const { apiKey, model = "whisper-large-v3-turbo", timeoutMs = 15_000 } = options;

  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", model);
  form.append("response_format", "json");

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

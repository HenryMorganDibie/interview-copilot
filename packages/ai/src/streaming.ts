/**
 * Reads a fetch Response body and invokes `onLine` for every complete line
 * (newline-delimited). Used by both the Ollama (NDJSON) and Groq/OpenAI-
 * compatible (SSE, "data: {...}") streaming formats.
 */
export async function readLines(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) onLine(line);
    }
  }

  const trailing = buffer.trim();
  if (trailing) onLine(trailing);
}

/** Extracts the JSON payload from an SSE "data: {...}" line. Returns null for "data: [DONE]" or non-data lines. */
export function parseSseDataLine(line: string): unknown | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice("data:".length).trim();
  if (payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Splits a streaming response into a user-facing "prose" part (the spoken
 * answer, forwarded to the UI chunk-by-chunk as it arrives) and a trailing
 * "metadata" part (JSON with keyPoints/confidence/etc, never shown raw).
 * Without this, streaming raw JSON straight to the UI would show literal
 * punctuation like `{"answer":"` instead of readable text.
 */
export class ProseMetadataSplitter {
  private buffer = "";
  private prose = "";
  private metadata = "";
  private foundDelimiter = false;

  constructor(
    private readonly delimiter: string,
    private readonly onProseChunk?: (text: string) => void,
  ) {}

  push(delta: string): void {
    if (this.foundDelimiter) {
      this.metadata += delta;
      return;
    }

    this.buffer += delta;
    const idx = this.buffer.indexOf(this.delimiter);
    if (idx !== -1) {
      const proseChunk = this.buffer.slice(0, idx);
      if (proseChunk) {
        this.prose += proseChunk;
        this.onProseChunk?.(proseChunk);
      }
      this.metadata += this.buffer.slice(idx + this.delimiter.length);
      this.foundDelimiter = true;
      this.buffer = "";
      return;
    }

    // Hold back enough trailing chars to still catch a delimiter split across two chunks.
    const safeLength = Math.max(0, this.buffer.length - (this.delimiter.length - 1));
    const toEmit = this.buffer.slice(0, safeLength);
    if (toEmit) {
      this.prose += toEmit;
      this.onProseChunk?.(toEmit);
      this.buffer = this.buffer.slice(safeLength);
    }
  }

  /** Call once the stream ends. Flushes any held-back text (delimiter never appeared) as prose. */
  finish(): void {
    if (!this.foundDelimiter && this.buffer) {
      this.prose += this.buffer;
      this.onProseChunk?.(this.buffer);
      this.buffer = "";
    }
  }

  get proseText(): string {
    return this.prose.trim();
  }

  get metadataText(): string {
    return this.metadata.trim();
  }

  get hasMetadata(): boolean {
    return this.foundDelimiter;
  }
}

/**
 * Tolerantly extracts a JSON object from model output that may include
 * leading/trailing prose or markdown fences despite being asked for raw JSON.
 */
export function extractJsonObject(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

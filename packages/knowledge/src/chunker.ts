export type ChunkOptions = {
  /** Target chunk size in characters. Default ~800 (roughly 150-200 tokens). */
  chunkSize?: number;
  /** Characters of overlap between consecutive chunks, to avoid losing context at boundaries. */
  overlap?: number;
};

/**
 * Splits normalized text into overlapping chunks along paragraph
 * boundaries where possible, falling back to a hard character split for
 * paragraphs longer than chunkSize. Simple and predictable — good enough
 * for CV/doc-length text; a semantic/structure-aware chunker (respecting
 * markdown headers, code blocks, etc) can replace this later without
 * touching callers.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const chunkSize = options.chunkSize ?? 800;
  const overlap = options.overlap ?? 100;

  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > chunkSize) {
      flush();
      for (let i = 0; i < paragraph.length; i += chunkSize - overlap) {
        chunks.push(paragraph.slice(i, i + chunkSize).trim());
      }
      continue;
    }

    if (current.length + paragraph.length + 2 > chunkSize) {
      flush();
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();

  return chunks.filter((c) => c.length > 0);
}

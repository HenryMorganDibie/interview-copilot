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
/**
 * Below this length, a paragraph is almost certainly a heading/label (e.g.
 * "Tell me about yourself:", "Skills:") rather than standalone content —
 * merged into the next paragraph before chunking so it can never end up
 * isolated in its own chunk. Without this, a short heading immediately
 * followed by a longer paragraph that pushes the pair over `chunkSize`
 * gets flushed alone right before the content it introduces, and — worse —
 * a heading that echoes a question's own wording (e.g. "Tell me about
 * yourself") can then outscore the actual answer in retrieval, since the
 * answer paragraph itself doesn't repeat the question's phrasing. Confirmed
 * directly: this exact scenario orphaned a real "tell me about yourself"
 * prepared-answer paragraph from its own heading.
 */
const MIN_STANDALONE_PARAGRAPH_LENGTH = 150;

function mergeOrphanHeadings(paragraphs: string[]): string[] {
  const merged: string[] = [];
  for (const paragraph of paragraphs) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && prev.length < MIN_STANDALONE_PARAGRAPH_LENGTH) {
      merged[merged.length - 1] = `${prev}\n\n${paragraph}`;
    } else {
      merged.push(paragraph);
    }
  }
  // A trailing short paragraph has no "next" paragraph to merge forward
  // into — attach it to the previous one instead so it isn't left orphaned.
  if (merged.length > 1) {
    const last = merged[merged.length - 1];
    if (last.length < MIN_STANDALONE_PARAGRAPH_LENGTH) {
      merged[merged.length - 2] = `${merged[merged.length - 2]}\n\n${last}`;
      merged.pop();
    }
  }
  return merged;
}

export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const chunkSize = options.chunkSize ?? 800;
  const overlap = options.overlap ?? 100;

  const paragraphs = mergeOrphanHeadings(
    text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean),
  );

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

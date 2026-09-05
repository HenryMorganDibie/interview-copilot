export type ParsedDocument = {
  text: string;
  mimeType: string;
};

/** Parses a file's raw bytes into plain text, based on its MIME type / filename. */
export async function parseDocument(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<ParsedDocument> {
  if (mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return { text: stripPdfPageMarkers(result.text), mimeType: "application/pdf" };
    } finally {
      await parser.destroy();
    }
  }

  // Markdown, plain text, and anything else we don't have a dedicated
  // parser for yet: decode as UTF-8. Good enough for .md/.txt; a
  // dedicated docx/etc parser can be added here later without touching
  // callers.
  return { text: buffer.toString("utf-8"), mimeType: mimeType || "text/plain" };
}

/**
 * pdf-parse inserts a page-boundary marker line ("-- 1 of 2 --") between
 * pages by default. Confirmed directly: these survived into the chunker as
 * their own isolated, near-empty chunks — and being short, generic text,
 * they scored plausibly against a wide range of unrelated queries,
 * crowding out real content in retrieval results for a completely
 * unrelated reason (their brevity, not their relevance). Stripped here so
 * they never reach the chunker at all, rather than trying to filter them
 * out downstream by length/content heuristics.
 */
function stripPdfPageMarkers(text: string): string {
  return text.replace(/^--\s*\d+\s*of\s*\d+\s*--$/gm, "");
}

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
      return { text: result.text, mimeType: "application/pdf" };
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

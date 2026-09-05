import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    ensurePdfJsCompatGlobals();
    const { PDFParse } = await import("pdf-parse");
    PDFParse.setWorker(resolvePdfWorkerSrc());
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
 * pdf-parse's pdfjs-dist dependency dynamically imports its own worker
 * module at runtime rather than needing an explicit path -- but that
 * internal path is computed relative to wherever its own code happened to
 * be bundled at *build* time. Confirmed live: in the esbuild-bundled
 * sidecar, that resolved to this dev machine's own repo path
 * (C:\KINGHENRYMORGAN_ANALYTICS\...), which only "worked" by accident
 * here because the file still happens to exist there -- it would fail on
 * any other machine the installer actually runs on. PDFParse.setWorker()
 * lets this be pointed at a path computed for real at *runtime* instead:
 * next to the actual running process (the packaged sidecar case, where
 * scripts/build-api-sidecar.mjs ships pdf.worker.mjs beside the exe), or
 * resolved from this source file's own real on-disk location in local dev
 * (tsx runs the real file tree, so import.meta.url is trustworthy there).
 *
 * Returned as a file:// URL string, not a plain path -- pdfjs-dist passes
 * this straight to a dynamic `import()`, which rejects a bare Windows path
 * like "C:\..." (parsed as if "C:" were a URL scheme) but accepts a
 * properly formed file:// URL.
 */
function resolvePdfWorkerSrc(): string {
  const packagedPath = path.join(path.dirname(process.execPath), "pdf.worker.mjs");
  const resolved = fs.existsSync(packagedPath)
    ? packagedPath
    : path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      );
  return pathToFileURL(resolved).href;
}

/**
 * pdf-parse's underlying pdfjs-dist "legacy" build is meant to run in
 * plain Node by polyfilling a few browser-only globals (DOMMatrix,
 * ImageData, Path2D) via its own dynamic `require()` of a Node-specific
 * compat shim. That dynamic require resolves a path computed at runtime
 * (via `__dirname`/`import.meta.url`), which breaks once this code is
 * bundled into a single file by esbuild (confirmed live: the computed
 * path came back `undefined`, throwing `ReferenceError: DOMMatrix is not
 * defined` at pdfjs-dist's module-init time, before any of our code even
 * runs) -- this only ever surfaced in the packaged sidecar build, never
 * in local dev (tsx runs the real file tree, where the shim's path
 * resolution works fine).
 *
 * These three globals are only actually exercised by pdfjs-dist's canvas
 * rendering path (rasterizing a page to an image) -- text extraction
 * (parser.getText(), the only thing this app uses pdf-parse for) never
 * touches them. Minimal stubs are enough to satisfy the module-init-time
 * reference and let pdfjs-dist load; if a real DOMMatrix/ImageData/Path2D
 * implementation is ever needed here (e.g. rendering a page thumbnail),
 * this must be revisited with a real polyfill, not these stubs.
 */
function ensurePdfJsCompatGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") g.DOMMatrix = class DOMMatrix {};
  if (typeof g.ImageData === "undefined") g.ImageData = class ImageData {};
  if (typeof g.Path2D === "undefined") g.Path2D = class Path2D {};
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

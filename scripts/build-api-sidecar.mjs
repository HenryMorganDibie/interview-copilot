#!/usr/bin/env node
/**
 * Builds apps/api into a standalone executable (no Node install, no
 * node_modules, no repo needed at runtime) and places it where Tauri's
 * `externalBin` config expects a sidecar binary. Four steps:
 *   1. esbuild bundles apps/api/src/server.ts + every workspace package it
 *      depends on into one CJS file (Node's built-in node:sqlite is left
 *      as an external/passthrough import -- it's resolved by whatever
 *      Node runtime actually executes the bundle, which step 3 provides).
 *   2. Node's Single Executable Application (SEA) feature turns that
 *      bundle into a blob.
 *   3. The blob is injected (via postject) into a copy of node.exe itself,
 *      producing one real standalone .exe with the runtime baked in.
 *   4. pdf-parse's worker module (pdf.worker.mjs) is copied alongside the
 *      exe -- it's loaded via a dynamic import esbuild can't inline, so it
 *      has to exist as a real file next to the bundle at runtime.
 *
 * Windows-only today, matching this project's current platform support
 * (see the README) -- step 3's "copy node.exe, inject blob" approach is
 * the same shape on macOS/Linux (no .exe extension, chmod +x instead of
 * needing to worry about the copied binary's signature), just not wired
 * up here yet.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "apps/desktop/src-tauri/binaries");
const bundlePath = path.join(outDir, "_api-bundle.cjs");
const blobPath = path.join(outDir, "_sea-prep.blob");
const seaConfigPath = path.join(outDir, "_sea-config.json");
const targetTriple = execFileSync("rustc", ["-vV"])
  .toString()
  .split("\n")
  .find((line) => line.startsWith("host:"))
  .split(":")[1]
  .trim();
const exePath = path.join(outDir, `interview-copilot-api-${targetTriple}.exe`);

fs.mkdirSync(outDir, { recursive: true });

console.log("[1/4] Bundling apps/api with esbuild...");
await esbuild.build({
  entryPoints: [path.join(repoRoot, "apps/api/src/server.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: bundlePath,
});

console.log("[2/4] Generating Node SEA blob...");
fs.writeFileSync(
  seaConfigPath,
  JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true }),
);
execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], { stdio: "inherit" });

console.log("[3/4] Injecting blob into a node.exe copy...");
fs.copyFileSync(process.execPath, exePath);
// postject is invoked via its programmatic API (not the npx/CLI form) --
// sidesteps Windows' npx.cmd/shell-spawning quirks entirely.
const { inject } = await import("postject");
await inject(exePath, "NODE_SEA_BLOB", fs.readFileSync(blobPath), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  overwrite: true,
});

fs.rmSync(bundlePath, { force: true });
fs.rmSync(blobPath, { force: true });
fs.rmSync(seaConfigPath, { force: true });

// pdf-parse's underlying pdfjs-dist ("legacy" build, for plain Node) runs
// PDF parsing via a separate worker module it dynamically imports at
// runtime -- esbuild can't inline that (the import path is computed, not
// static), so the file has to physically exist next to the bundle instead.
// Confirmed live: without this, every PDF upload failed with "Setting up
// fake worker failed: Cannot find module '.../pdf.worker.mjs'" in the
// packaged sidecar (worked fine in dev, where the real node_modules tree
// is intact). tauri.conf.json's bundle.resources ships this file
// alongside the sidecar exe in the installer.
console.log("[4/4] Copying pdf.worker.mjs (pdfjs-dist's Node worker module)...");
fs.copyFileSync(
  path.join(repoRoot, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
  path.join(outDir, "pdf.worker.mjs"),
);

console.log(`Sidecar built: ${exePath}`);

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import multer from "multer";
import {
  createDefaultRouter,
  generateLikelyQuestions,
  generateStarStory,
  parseJobDescription,
} from "@interview-copilot/ai";
import { transcribeAudioChunk } from "@interview-copilot/transcription";
import {
  chunksToEvidence,
  findWeakAreas,
  ingestDocument,
  matchJobRequirements,
  rankStrongestStories,
  retrieveRelevantChunks,
  summarizeMatches,
} from "@interview-copilot/knowledge";
import { deleteKnowledgeSource, listKnowledgeSources } from "@interview-copilot/database";
import {
  getAuthenticatedUser,
  ingestRepository,
  listUserRepos,
  pollDeviceToken,
  startDeviceFlow,
} from "@interview-copilot/github";
import { createDefaultSearchProvider, formatWebResearch } from "@interview-copilot/search";
import type {
  AnswerGenerationContext,
  InterviewContext,
  KnowledgeSourceType,
} from "@interview-copilot/shared";

const PORT = Number(process.env.API_PORT ?? 8722);
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// A registered, public OAuth App client ID — not a secret. GitHub's device
// flow needs no client secret (see packages/github/src/deviceFlow.ts), so
// this can be embedded the same way `gh`/other public CLIs embed their own
// client ID, making Device Flow a genuine zero-config default instead of
// something every cloner has to register their own OAuth App for. Anyone
// who wants to authorize against their own App instead can still override
// via GITHUB_CLIENT_ID in .env.
const DEFAULT_GITHUB_CLIENT_ID = "Ov23lijfTMvkFixHJ77R";
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || DEFAULT_GITHUB_CLIENT_ID;
const searchProvider = createDefaultSearchProvider(process.env.WEB_SEARCH_API_KEY);
// A directly-issued personal access token is simpler than full OAuth for a
// single-user desktop tool — no OAuth App registration needed. Device flow
// (below) stays available for whenever a proper multi-step connect UI is
// wanted instead; both end up populating the same in-memory token.
let githubToken: string | undefined = process.env.GITHUB_TOKEN;

// Prep-time work (likely questions, STAR stories) isn't latency-sensitive,
// so it's worth trying the free local model first even though a cold load
// costs a few seconds.
const router = createDefaultRouter({
  groqApiKey: GROQ_API_KEY,
  anthropicApiKey: ANTHROPIC_API_KEY,
});
// Live-session answer generation and question analysis skip the local pool
// for the common case — the candidate is watching this happen in real time,
// and a cold local-model load (the dominant tail latency in
// docs/eval/RESULTS.md) is exactly the "obviously waiting" experience that
// must not happen live. But the local pool stays wired in as a last resort
// (`"last"`, not `false`): confirmed live 2026-09-05 that Groq's 8K TPM free
// tier can be exhausted by a burst of rapid live questions, and with no
// fallback at all this silently returned "Unable to generate answer." for
// every question until the rate-limit window cleared — see
// packages/ai/src/createDefaultRouter.ts for the full account.
const liveRouter = createDefaultRouter({
  groqApiKey: GROQ_API_KEY,
  anthropicApiKey: ANTHROPIC_API_KEY,
  includeLocalPool: "last",
});

const app = express();
// This API only ever binds to 127.0.0.1 and is never exposed beyond this
// machine, so origin whitelisting buys no real security here — it was
// actually breaking the installed app, which serves its frontend from
// Tauri's bundled-asset origin (https://tauri.localhost), not
// http://localhost:1420 (that's only the Vite dev server's origin).
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Missing audio file" });
    return;
  }
  if (!GROQ_API_KEY) {
    res.status(503).json({ error: "Transcription unavailable: GROQ_API_KEY not configured" });
    return;
  }

  try {
    const blob = new Blob([new Uint8Array(req.file.buffer)], { type: req.file.mimetype });
    const extension = req.file.mimetype.includes("wav") ? "wav" : "webm";
    const contextPrompt = typeof req.body?.contextPrompt === "string" ? req.body.contextPrompt : undefined;
    if (process.env.DEBUG_SAVE_AUDIO) {
      const dir = process.env.DEBUG_SAVE_AUDIO;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `chunk-${Date.now()}.${extension}`), req.file.buffer);
    }
    const text = await transcribeAudioChunk(blob, `chunk.${extension}`, {
      apiKey: GROQ_API_KEY,
      contextPrompt,
    });
    console.log(
      `[transcribe] bytes=${req.file.buffer.length} contextPromptLen=${contextPrompt?.length ?? 0} -> "${text}"`,
    );
    res.json({ text });
  } catch (error) {
    // Never crash the session because one transcription request failed (spec: graceful degradation).
    console.error("transcription failed:", error);
    res.status(502).json({ error: "Transcription unavailable" });
  }
});

app.post("/api/answer", async (req, res) => {
  const context = req.body as AnswerGenerationContext | undefined;
  if (!context?.question) {
    res.status(400).json({ error: "Missing question in request body" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Evidence always comes from a real retrieval against the knowledge base,
  // never trusted from the client — the whole point of the evidence layer
  // is grounding the answer in what's actually stored, not whatever a
  // caller happens to send. Retrieval failure degrades to no evidence
  // rather than failing the whole request (spec: graceful degradation).
  //
  // Always runs, regardless of requiresPersonalExperience — an earlier
  // version hard-skipped retrieval when that flag was false, but a second
  // evaluation run showed the analyzer sometimes gets that flag wrong even
  // for genuinely personal questions, which then lost all evidence outright.
  // Instead, a non-personal classification just raises the bar for what
  // counts as usable evidence (chunksToEvidence's `strict` mode), so a
  // borderline/spurious match can't attach a misleading source, but a
  // strong match still comes through even if the analyzer guessed wrong.
  // Evidence retrieval and web research are independent of each other, so
  // they run concurrently rather than back-to-back — on a live-session
  // question needing both, that halves the wait for whichever is slower
  // instead of paying the sum of both.
  const evidencePromise = retrieveRelevantChunks(context.question)
    .then((retrieved) => chunksToEvidence(retrieved, context.analysis.requiresPersonalExperience === false))
    .catch((error) => {
      console.error("evidence retrieval failed:", error);
      return [];
    });

  // Only search the web when the question actually needs current/external
  // info (per the question analyzer's requiresWebResearch flag) — not on
  // every question, and never in place of personal evidence. Unavailable
  // (no key configured, or the search itself fails) degrades to no web
  // context rather than failing the answer.
  const webResearchPromise = context.analysis.requiresWebResearch
    ? searchProvider
      ? searchProvider
          .search(context.question)
          .then((results) => formatWebResearch(results))
          .catch((error) => {
            console.error("web search failed:", error);
            return "Web research unavailable.";
          })
      : Promise.resolve("Web research unavailable.")
    : Promise.resolve(undefined);

  const [evidence, webResearch] = await Promise.all([evidencePromise, webResearchPromise]);
  context.evidence = evidence;
  context.webResearch = webResearch;

  try {
    const result = await liveRouter.generateAnswer(context, (chunk) => {
      if (chunk.delta) {
        res.write(`event: delta\ndata: ${JSON.stringify({ text: chunk.delta })}\n\n`);
      }
    });
    res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
  } catch (error) {
    console.error("answer generation failed:", error);
    res.write(`event: error\ndata: ${JSON.stringify({ error: "Unable to generate answer." })}\n\n`);
  } finally {
    res.end();
  }
});

app.post("/api/analyze-question", async (req, res) => {
  const context = req.body as InterviewContext | undefined;
  if (!context?.sessionId) {
    res.status(400).json({ error: "Missing sessionId in request body" });
    return;
  }

  try {
    const analysis = await liveRouter.analyzeQuestion(context);
    res.json(analysis);
  } catch (error) {
    console.error("question analysis failed:", error);
    res.status(502).json({ error: "Question analysis unavailable" });
  }
});

const VALID_SOURCE_TYPES: readonly KnowledgeSourceType[] = [
  "cv",
  "github",
  "project",
  "document",
  "job_description",
];

app.post("/api/knowledge/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Missing file" });
    return;
  }

  const sourceType = req.body.sourceType as string | undefined;
  if (!sourceType || !VALID_SOURCE_TYPES.includes(sourceType as KnowledgeSourceType)) {
    res.status(400).json({ error: `sourceType must be one of: ${VALID_SOURCE_TYPES.join(", ")}` });
    return;
  }

  try {
    const result = await ingestDocument({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      sourceType: sourceType as KnowledgeSourceType,
      sourceName: (req.body.sourceName as string | undefined) || req.file.originalname,
    });
    res.json(result);
  } catch (error) {
    console.error("document ingestion failed:", error);
    res.status(502).json({ error: "Failed to ingest document" });
  }
});

app.get("/api/knowledge/sources", async (_req, res) => {
  try {
    const sources = await listKnowledgeSources();
    res.json(sources);
  } catch (error) {
    console.error("failed to list knowledge sources:", error);
    res.status(502).json({ error: "Knowledge base unavailable" });
  }
});

app.delete("/api/knowledge/sources/:id", async (req, res) => {
  try {
    await deleteKnowledgeSource(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    console.error("failed to delete knowledge source:", error);
    res.status(502).json({ error: "Failed to delete source" });
  }
});

app.get("/api/github/status", async (_req, res) => {
  // Device flow needs a registered GitHub OAuth App (GITHUB_CLIENT_ID) — a
  // real barrier for anyone cloning this repo who isn't Henry. Reported here
  // so the UI can fall back to a pasted personal access token instead of
  // offering a "Connect GitHub" button that would just 503.
  const deviceFlowAvailable = Boolean(GITHUB_CLIENT_ID);
  if (!githubToken) {
    res.json({ connected: false, deviceFlowAvailable });
    return;
  }
  const user = await getAuthenticatedUser(githubToken);
  if (!user) {
    // Token is set but no longer valid (revoked/expired) — don't keep claiming connected.
    githubToken = undefined;
    res.json({ connected: false, deviceFlowAvailable });
    return;
  }
  res.json({ connected: true, username: user.login, deviceFlowAvailable });
});

app.post("/api/github/connect", async (req, res) => {
  const token = req.body?.token as string | undefined;
  if (!token?.trim()) {
    res.status(400).json({ error: "Missing token in request body" });
    return;
  }
  const user = await getAuthenticatedUser(token.trim());
  if (!user) {
    res.status(401).json({ error: "GitHub rejected that token — check it's valid and hasn't expired." });
    return;
  }
  githubToken = token.trim();
  res.json({ connected: true, username: user.login });
});

app.post("/api/github/device/start", async (_req, res) => {
  if (!GITHUB_CLIENT_ID) {
    res.status(503).json({ error: "GITHUB_CLIENT_ID not configured" });
    return;
  }
  try {
    const result = await startDeviceFlow(GITHUB_CLIENT_ID);
    res.json(result);
  } catch (error) {
    console.error("GitHub device flow start failed:", error);
    res.status(502).json({ error: "Failed to start GitHub connection" });
  }
});

app.post("/api/github/device/poll", async (req, res) => {
  const deviceCode = req.body?.deviceCode as string | undefined;
  if (!GITHUB_CLIENT_ID || !deviceCode) {
    res.status(400).json({ error: "Missing deviceCode or GITHUB_CLIENT_ID not configured" });
    return;
  }
  const result = await pollDeviceToken(GITHUB_CLIENT_ID, deviceCode);
  if (result.status === "success") {
    githubToken = result.accessToken;
  }
  res.json(result);
});

app.get("/api/github/repos", async (_req, res) => {
  if (!githubToken) {
    res.status(401).json({ error: "GitHub not connected" });
    return;
  }
  try {
    const repos = await listUserRepos(githubToken);
    res.json(repos);
  } catch (error) {
    console.error("failed to list GitHub repos:", error);
    res.status(502).json({ error: "Failed to list repositories" });
  }
});

app.post("/api/github/ingest", async (req, res) => {
  const owner = req.body?.owner as string | undefined;
  const repo = req.body?.repo as string | undefined;
  if (!owner || !repo) {
    res.status(400).json({ error: "Missing owner or repo in request body" });
    return;
  }

  try {
    const result = await ingestRepository(router, owner, repo, githubToken);
    res.json(result);
  } catch (error) {
    console.error("GitHub repo ingestion failed:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : "Failed to ingest repository" });
  }
});

app.post("/api/job-description/analyze", async (req, res) => {
  const text = req.body?.text as string | undefined;
  if (!text?.trim()) {
    res.status(400).json({ error: "Missing text in request body" });
    return;
  }

  try {
    const profile = await parseJobDescription(router, text);
    const requirementMatches = await matchJobRequirements(profile);
    const strongestStories = rankStrongestStories(requirementMatches);
    const weakAreas = findWeakAreas(requirementMatches);

    let likelyQuestions: string[] = [];
    try {
      likelyQuestions = await generateLikelyQuestions(router, profile, summarizeMatches(requirementMatches));
    } catch (error) {
      // Likely-questions is a nice-to-have on top of the core match report; don't fail the whole request for it.
      console.error("likely-question generation failed:", error);
    }

    // STAR stories for the top 2 strongest-matched sources — grounded in
    // their real stored content, never invented. Best-effort: a failure
    // here shouldn't sink the rest of the (already-useful) report.
    let starStories: Awaited<ReturnType<typeof generateStarStory>>[] = [];
    try {
      const topSources = strongestStories.slice(0, 2);
      if (topSources.length > 0) {
        const allSources = await listKnowledgeSources();
        starStories = await Promise.all(
          topSources.map((s) => {
            const source = allSources.find((src) => src.sourceName === s.sourceName);
            if (!source) return Promise.resolve(null);
            return generateStarStory(router, s.sourceName, source.rawText);
          }),
        );
      }
    } catch (error) {
      console.error("STAR story generation failed:", error);
    }

    res.json({
      profile,
      requirementMatches,
      likelyQuestions,
      strongestStories,
      weakAreas,
      starStories: starStories.filter((s): s is NonNullable<typeof s> => s !== null),
    });
  } catch (error) {
    console.error("job description analysis failed:", error);
    res.status(502).json({ error: "Job description analysis unavailable" });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Interview Copilot API listening on http://127.0.0.1:${PORT}`);
});

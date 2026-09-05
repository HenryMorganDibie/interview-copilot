import type {
  AnswerGenerationContext,
  InterviewAnswer,
  InterviewContext,
  JobMatchReport,
  KnowledgeSource,
  KnowledgeSourceType,
  QuestionAnalysis,
} from "@interview-copilot/shared";

export type { JobMatchReport } from "@interview-copilot/shared";

/**
 * Base URL of the local apps/api server. This app never talks to Ollama,
 * Groq, or Anthropic directly from the frontend — every provider call goes
 * through this local backend so API keys stay server-side (see apps/api).
 */
const API_BASE_URL = "http://127.0.0.1:8722";

export class ApiUnavailableError extends Error {
  constructor(message = "Backend API is unavailable") {
    super(message);
    this.name = "ApiUnavailableError";
  }
}

export async function transcribeChunk(audio: Blob, contextPrompt?: string): Promise<string> {
  const extension = audio.type.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("audio", audio, `chunk.${extension}`);
  if (contextPrompt) form.append("contextPrompt", contextPrompt);

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/transcribe`, { method: "POST", body: form });
  } catch {
    throw new ApiUnavailableError();
  }

  if (!res.ok) return "";
  const data = (await res.json()) as { text?: string };
  return data.text ?? "";
}

export async function analyzeQuestion(context: InterviewContext): Promise<QuestionAnalysis | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/analyze-question`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(context),
    });
    if (!res.ok) return null;
    return (await res.json()) as QuestionAnalysis;
  } catch {
    return null;
  }
}

/**
 * Streams an answer via SSE. `onDelta` fires as prose tokens arrive;
 * the returned promise resolves with the final structured answer once
 * the stream's "done" event lands (or rejects if the stream errors/closes
 * without one — callers should show "Unable to generate answer." on catch).
 */
export async function generateAnswerStream(
  context: AnswerGenerationContext,
  onDelta: (text: string) => void,
): Promise<InterviewAnswer> {
  const res = await fetch(`${API_BASE_URL}/api/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(context),
  });

  if (!res.ok || !res.body) {
    throw new ApiUnavailableError();
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";

  return new Promise<InterviewAnswer>((resolve, reject) => {
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) currentEvent = line.slice("event:".length).trim();
              if (line.startsWith("data:")) {
                const payload = JSON.parse(line.slice("data:".length).trim());
                if (currentEvent === "delta" && typeof payload.text === "string") {
                  onDelta(payload.text);
                } else if (currentEvent === "done") {
                  resolve(payload as InterviewAnswer);
                  return;
                } else if (currentEvent === "error") {
                  reject(new Error(payload.error ?? "Unable to generate answer."));
                  return;
                }
              }
            }
          }
        }
        reject(new Error("Unable to generate answer."));
      } catch (err) {
        reject(err);
      }
    })();
  });
}

export async function uploadKnowledgeDocument(
  file: File,
  sourceType: KnowledgeSourceType,
  sourceName?: string,
): Promise<{ sourceId: string; chunkCount: number }> {
  const form = new FormData();
  form.append("file", file);
  form.append("sourceType", sourceType);
  if (sourceName) form.append("sourceName", sourceName);

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/knowledge/upload`, { method: "POST", body: form });
  } catch {
    throw new ApiUnavailableError();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to upload document");
  }
  return res.json();
}

export async function listKnowledgeSources(): Promise<KnowledgeSource[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/knowledge/sources`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function deleteKnowledgeSource(sourceId: string): Promise<void> {
  await fetch(`${API_BASE_URL}/api/knowledge/sources/${sourceId}`, { method: "DELETE" }).catch(() => {});
}

export async function analyzeJobDescription(text: string): Promise<JobMatchReport> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/job-description/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    throw new ApiUnavailableError();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to analyze job description");
  }
  return res.json();
}

export type GitHubStatus = { connected: boolean; username?: string };

export async function getGitHubStatus(): Promise<GitHubStatus> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/github/status`);
    if (!res.ok) return { connected: false };
    return await res.json();
  } catch {
    return { connected: false };
  }
}

export type DeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export async function startGitHubDeviceFlow(): Promise<DeviceCodeResponse> {
  const res = await fetch(`${API_BASE_URL}/api/github/device/start`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to start GitHub connection");
  }
  return res.json();
}

export type DevicePollResult =
  | { status: "pending" }
  | { status: "success"; accessToken: string }
  | { status: "expired" }
  | { status: "error"; message: string };

export async function pollGitHubDevice(deviceCode: string): Promise<DevicePollResult> {
  const res = await fetch(`${API_BASE_URL}/api/github/device/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  return res.json();
}

export type GitHubRepo = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  description: string | null;
  private: boolean;
  language: string | null;
  topics: string[];
  updatedAt: string;
};

export async function listGitHubRepos(): Promise<GitHubRepo[]> {
  const res = await fetch(`${API_BASE_URL}/api/github/repos`);
  if (!res.ok) return [];
  return res.json();
}

export async function ingestGitHubRepo(owner: string, repo: string): Promise<{ sourceId: string; chunkCount: number }> {
  const res = await fetch(`${API_BASE_URL}/api/github/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to ingest repository");
  }
  return res.json();
}

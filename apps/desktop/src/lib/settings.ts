import type { ResponseMode } from "@interview-copilot/shared";

const RESPONSE_MODE_KEY = "interview-copilot:response-mode";
const VALID_MODES: readonly ResponseMode[] = ["direct", "talking_points", "follow_up"];

export function getResponseMode(): ResponseMode {
  try {
    const stored = localStorage.getItem(RESPONSE_MODE_KEY);
    if (stored && (VALID_MODES as string[]).includes(stored)) return stored as ResponseMode;
  } catch {
    // localStorage unavailable (private window, etc) — fall through to default.
  }
  return "direct";
}

export function setResponseMode(mode: ResponseMode): void {
  try {
    localStorage.setItem(RESPONSE_MODE_KEY, mode);
  } catch {
    // Non-fatal: the mode just won't persist across restarts.
  }
}

const JOB_DESCRIPTION_KEY = "interview-copilot:job-description";

/**
 * The job description pasted on the Job Descriptions page, persisted so a
 * live session started later in the same setup flow can ground answers
 * against the actual role/company instead of generic evidence — without
 * this, `LiveSessionOrchestrator.jobDescription` was always undefined
 * because the analyzed text lived only in that page's component state.
 */
export function getJobDescription(): string {
  try {
    return localStorage.getItem(JOB_DESCRIPTION_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setJobDescription(text: string): void {
  try {
    localStorage.setItem(JOB_DESCRIPTION_KEY, text);
  } catch {
    // Non-fatal: just won't persist across restarts.
  }
}

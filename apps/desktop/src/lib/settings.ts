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

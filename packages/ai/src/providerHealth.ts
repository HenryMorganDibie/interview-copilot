export type FailureKind = "timeout" | "rate_limit" | "error";

export class ProviderTimeoutError extends Error {
  constructor(message = "Provider timed out") {
    super(message);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderRateLimitError extends Error {
  constructor(message = "Provider rate-limited") {
    super(message);
    this.name = "ProviderRateLimitError";
  }
}

type HealthEntry = {
  consecutiveFailures: number;
  cooldownUntil: number;
};

const BASE_COOLDOWN_MS = 2_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
/** Rate limits reported by providers (Groq RPM/TPM) reset on the order of a minute. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/**
 * Tracks per-provider health so the router can skip providers/models that
 * are currently rate-limited or repeatedly failing, instead of hammering them.
 */
export class ProviderHealthTracker {
  private entries = new Map<string, HealthEntry>();

  isAvailable(id: string, now = Date.now()): boolean {
    const entry = this.entries.get(id);
    if (!entry) return true;
    return now >= entry.cooldownUntil;
  }

  cooldownRemainingMs(id: string, now = Date.now()): number {
    const entry = this.entries.get(id);
    if (!entry) return 0;
    return Math.max(0, entry.cooldownUntil - now);
  }

  recordSuccess(id: string): void {
    this.entries.delete(id);
  }

  recordFailure(id: string, kind: FailureKind, now = Date.now()): void {
    const prev = this.entries.get(id);
    const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;

    const cooldownMs =
      kind === "rate_limit"
        ? RATE_LIMIT_COOLDOWN_MS
        : Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** (consecutiveFailures - 1));

    this.entries.set(id, { consecutiveFailures, cooldownUntil: now + cooldownMs });
  }

  classify(error: unknown): FailureKind {
    if (error instanceof ProviderTimeoutError) return "timeout";
    if (error instanceof ProviderRateLimitError) return "rate_limit";
    if (error instanceof DOMException && error.name === "AbortError") return "timeout";
    return "error";
  }
}

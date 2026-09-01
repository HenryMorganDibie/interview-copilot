import { ProviderTimeoutError } from "./providerHealth.js";

/**
 * Runs `fn` with an AbortSignal that fires after `timeoutMs`. Converts the
 * resulting AbortError into a ProviderTimeoutError so the router's health
 * tracker can classify it correctly (excessive latency counts as a failure).
 */
export async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fn(controller.signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ProviderTimeoutError(`Timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

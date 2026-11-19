// Retry policy shared by the API client and the token client: bounded
// exponential backoff with full jitter, and `Retry-After` honored exactly.

export const DEFAULT_RETRY_POLICY = Object.freeze({
  /** Total attempts, including the first. */
  maxAttempts: 5,
  /** First backoff ceiling; doubles per attempt. */
  baseDelayMs: 250,
  /** Largest backoff the kit computes itself. */
  maxDelayMs: 20_000,
  /** Largest `Retry-After` the kit waits in-process. A longer one is returned to the caller to schedule. */
  maxRetryAfterMs: 120_000,
});

/** Statuses where the same request can succeed later. */
export const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);

export function retryPolicy(overrides = {}) {
  const policy = { ...DEFAULT_RETRY_POLICY, ...overrides };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`retry.${key} must be a non-negative number`);
  }
  if (policy.maxAttempts < 1) throw new TypeError('retry.maxAttempts must be at least 1');
  return policy;
}

/**
 * `Retry-After` in milliseconds: delta-seconds or an HTTP-date (RFC 9110
 * section 10.2.3). Undefined when absent or unreadable.
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/** Full-jitter backoff for the given 1-based attempt that just failed. */
export function backoffDelay(attempt, policy, random = Math.random) {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

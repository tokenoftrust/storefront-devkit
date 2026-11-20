import { defaultSleep, parseRetryAfter } from './retry.js';

const MINUTE_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;

function resetDelayMs(response, nowMs) {
  const headers = response.headers;
  if (response.status !== 429 && headers.get('x-rate-limit-remaining') !== '0') return 0;
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'), nowMs);
  const reset = headers.get('x-rate-limit-reset');
  const resetAtMs = reset !== null && /^\d+$/.test(reset) ? Number(reset) * 1000 : 0;
  const resetMs = resetAtMs > 0 && Number.isFinite(resetAtMs) ? resetAtMs - nowMs : 0;
  return Math.max(retryAfterMs ?? 0, resetMs);
}

/**
 * Pace outbound requests through a shared token bucket. A wrapper records
 * cooldowns for future requests and returns the original response.
 */
export function createRateLimiter({ requestsPerMinute, burst = 1, now = Date.now, sleep = defaultSleep }) {
  const intervalMs = MINUTE_MS / requestsPerMinute;
  if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0 || !Number.isFinite(intervalMs)) {
    throw new TypeError('requestsPerMinute must be a positive finite rate');
  }
  if (!Number.isSafeInteger(burst) || burst < 1) throw new TypeError('burst must be a positive safe integer');

  let tokens = burst;
  let refillAt = now();
  let blockedUntil = -Infinity;
  let queue = Promise.resolve();

  async function takeToken() {
    for (;;) {
      const at = now();
      const elapsed = Math.max(0, at - refillAt);
      tokens = Math.min(burst, tokens + elapsed / intervalMs);
      refillAt = Math.max(at, refillAt);

      if (tokens >= 1 && at >= blockedUntil) {
        tokens--;
        return;
      }
      // Another response can extend the cooldown while this request sleeps.
      const waitMs = Math.max((1 - tokens) * intervalMs, blockedUntil - at);
      await sleep(Math.min(MAX_TIMER_MS, Math.ceil(waitMs)));
    }
  }

  function acquire() {
    const next = queue.then(takeToken);
    queue = next.catch(() => {});
    return next;
  }

  return {
    acquire,
    wrap(fetchFn, { parseResetSeconds } = {}) {
      return async (...args) => {
        await acquire();
        const response = await fetchFn(...args);
        const at = now();
        const seconds = parseResetSeconds?.(response);
        const delayMs = seconds === undefined ? resetDelayMs(response, at) : seconds * 1000;
        if (Number.isFinite(delayMs) && delayMs > 0) blockedUntil = Math.max(blockedUntil, at + delayMs);
        return response;
      };
    },
  };
}

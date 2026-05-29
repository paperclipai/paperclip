// Circuit breaker: cap transient_failure_retry schedules per issue to prevent
// a failing issue from generating unbounded retry runs.
export const TRANSIENT_RETRY_CIRCUIT_BREAKER_MAX = 3;
export const TRANSIENT_RETRY_CIRCUIT_BREAKER_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

// issueId → array of retry-schedule timestamps (epoch ms) within the rolling window
const transientRetryTimestamps = new Map<string, number[]>();

export function recordTransientRetryScheduled(
  issueId: string,
  nowMs: number = Date.now(),
): { count: number; limitExceeded: boolean } {
  const windowStart = nowMs - TRANSIENT_RETRY_CIRCUIT_BREAKER_WINDOW_MS;
  const prev = (transientRetryTimestamps.get(issueId) ?? []).filter((t) => t > windowStart);
  prev.push(nowMs);
  transientRetryTimestamps.set(issueId, prev);
  return { count: prev.length, limitExceeded: prev.length >= TRANSIENT_RETRY_CIRCUIT_BREAKER_MAX };
}

export function clearTransientRetryCircuitBreaker(issueId: string): void {
  transientRetryTimestamps.delete(issueId);
}

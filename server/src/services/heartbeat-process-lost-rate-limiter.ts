export const PROCESS_LOST_RATE_LIMIT_MAX = 3;
export const PROCESS_LOST_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// issueId → array of failure timestamps (epoch ms) within the rolling window
const processLostTimestamps = new Map<string, number[]>();

export function recordProcessLostFailure(
  issueId: string,
  nowMs: number = Date.now(),
): { count: number; limitExceeded: boolean } {
  const windowStart = nowMs - PROCESS_LOST_RATE_LIMIT_WINDOW_MS;
  const prev = (processLostTimestamps.get(issueId) ?? []).filter((t) => t > windowStart);
  prev.push(nowMs);
  processLostTimestamps.set(issueId, prev);
  return { count: prev.length, limitExceeded: prev.length >= PROCESS_LOST_RATE_LIMIT_MAX };
}

export function clearProcessLostRateLimit(issueId: string): void {
  processLostTimestamps.delete(issueId);
}

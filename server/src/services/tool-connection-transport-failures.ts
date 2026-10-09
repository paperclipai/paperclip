/**
 * Counts consecutive transport failures (network error, timeout) per remote
 * tool connection. One isolated failure must not mark a healthy connection as
 * `error`: the caller only does that after `threshold` failures that follow
 * each other within `windowMs`. A success resets the count.
 */
export const REMOTE_TRANSPORT_FAILURE_THRESHOLD = 3;
export const REMOTE_TRANSPORT_FAILURE_WINDOW_MS = 10 * 60 * 1000;

export function createTransportFailureTracker(options: {
  threshold?: number;
  windowMs?: number;
  now?: () => number;
} = {}) {
  const threshold = options.threshold ?? REMOTE_TRANSPORT_FAILURE_THRESHOLD;
  const windowMs = options.windowMs ?? REMOTE_TRANSPORT_FAILURE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const state = new Map<string, { count: number; lastAt: number }>();

  return {
    /** Records a failure. Returns true when the connection should be marked as failed. */
    recordFailure(connectionId: string): boolean {
      const at = now();
      const previous = state.get(connectionId);
      const count = previous && at - previous.lastAt < windowMs ? previous.count + 1 : 1;
      state.set(connectionId, { count, lastAt: at });
      return count >= threshold;
    },
    recordSuccess(connectionId: string): void {
      state.delete(connectionId);
    },
  };
}

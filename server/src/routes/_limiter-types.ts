export interface SlidingWindowLimiter {
  consume(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> | { allowed: boolean; retryAfterSeconds: number };
  /** Stop any background timers / cleanup. */
  stop(): Promise<void> | void;
}

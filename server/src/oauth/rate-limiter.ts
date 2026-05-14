export interface SlidingWindowLimiterOptions {
  limit: number;
  windowMs: number;
}

export interface SlidingWindowLimiter {
  check(key: string): Promise<boolean>;
}

export function createSlidingWindowLimiter(opts: SlidingWindowLimiterOptions): SlidingWindowLimiter {
  const buckets = new Map<string, number[]>();
  return {
    async check(key) {
      const now = Date.now();
      const cutoff = now - opts.windowMs;
      const bucket = buckets.get(key) ?? [];
      while (bucket.length > 0 && bucket[0] <= cutoff) bucket.shift();
      if (bucket.length === 0) buckets.delete(key);
      if (bucket.length >= opts.limit) {
        buckets.set(key, bucket);
        return false;
      }
      bucket.push(now);
      buckets.set(key, bucket);
      return true;
    },
  };
}

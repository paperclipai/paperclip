import {
  COMPANY_SEARCH_RATE_LIMIT_MAX_REQUESTS,
  COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS,
  companySearchRateLimitKey,
  type CompanySearchRateLimiter,
  type CompanySearchRateLimitResult,
} from "./company-search-rate-limit.js";

const KEY_PREFIX = "ratelimit:companysearch:";

/**
 * Minimal structural surface of the Upstash Redis client we depend on. Declared
 * locally so the limiter can be unit-tested with a fake pipeline and so the
 * `@upstash/redis` import stays optional at type-check time.
 */
export type RateLimitRedisPipeline = {
  incr(key: string): RateLimitRedisPipeline;
  pexpire(key: string, ms: number, option?: "NX"): RateLimitRedisPipeline;
  pttl(key: string): RateLimitRedisPipeline;
  exec<TResults extends unknown[] = unknown[]>(): Promise<TResults>;
};

export type RateLimitRedisClient = {
  pipeline(): RateLimitRedisPipeline;
};

export type UpstashCompanySearchRateLimiterOptions = {
  redis: RateLimitRedisClient;
  windowMs?: number;
  maxRequests?: number;
  /**
   * When the Redis round-trip fails, block the request (true, the safe default)
   * or allow it through (false). Fail-closed is recommended for production so a
   * Redis outage cannot be used to bypass the limit.
   */
  failClosed?: boolean;
};

/**
 * Distributed fixed-window limiter backed by Upstash Redis. A single pipeline runs
 * INCR (count this hit), PEXPIRE ... NX (arm the window TTL only on the first hit so
 * the window does not slide), and PTTL (read the remaining window for Retry-After).
 */
export function createUpstashCompanySearchRateLimiter(
  options: UpstashCompanySearchRateLimiterOptions,
): CompanySearchRateLimiter {
  const windowMs = options.windowMs ?? COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS;
  const maxRequests = options.maxRequests ?? COMPANY_SEARCH_RATE_LIMIT_MAX_REQUESTS;
  const failClosed = options.failClosed ?? true;
  const redis = options.redis;

  function blockedResult(retryAfterSeconds: number): CompanySearchRateLimitResult {
    return {
      allowed: false,
      limit: maxRequests,
      remaining: 0,
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    };
  }

  return {
    async consume(actor) {
      const key = `${KEY_PREFIX}${companySearchRateLimitKey(actor)}`;
      let count: number;
      let pttlMs: number;
      try {
        const pipeline = redis.pipeline();
        pipeline.incr(key);
        pipeline.pexpire(key, windowMs, "NX");
        pipeline.pttl(key);
        const [incrResult, , pttlResult] = await pipeline.exec<[number, number, number]>();
        count = Number(incrResult);
        pttlMs = Number(pttlResult);
      } catch {
        if (failClosed) {
          return blockedResult(Math.ceil(windowMs / 1000));
        }
        // Fail open: allow the request through when Redis is unreachable.
        return {
          allowed: true,
          limit: maxRequests,
          remaining: maxRequests,
          retryAfterSeconds: 0,
        };
      }

      // PTTL returns -1 (no expiry) or -2 (no key) on edge cases; fall back to the
      // full window so Retry-After is never negative.
      const retryAfterSeconds = pttlMs > 0 ? Math.ceil(pttlMs / 1000) : Math.ceil(windowMs / 1000);

      if (count > maxRequests) {
        return blockedResult(retryAfterSeconds);
      }

      return {
        allowed: true,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - count),
        retryAfterSeconds: 0,
      };
    },
  };
}

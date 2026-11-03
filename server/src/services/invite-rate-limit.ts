// Generic per-IP sliding-window rate limiter for the public, unauthenticated
// invite-token endpoints (`/invites/:token*`). These routes accept a token in
// the URL and look it up by hash, so without a limit the token space is
// online-enumerable. The limiter is in-memory and therefore per-process; for a
// horizontally-scaled deployment it bounds enumeration per instance, which is
// the meaningful protection here (a brute-force still has to defeat the limit on
// every replica). It intentionally has no external dependency.

export const INVITE_RATE_LIMIT_WINDOW_MS = 60_000;
export const INVITE_RATE_LIMIT_MAX_REQUESTS = 20;

export type InviteRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export type InviteRateLimiter = {
  consume(ip: string): InviteRateLimitResult;
};

export function createInviteRateLimiter(options: {
  windowMs?: number;
  maxRequests?: number;
  now?: () => number;
} = {}): InviteRateLimiter {
  const windowMs = options.windowMs ?? INVITE_RATE_LIMIT_WINDOW_MS;
  const maxRequests = options.maxRequests ?? INVITE_RATE_LIMIT_MAX_REQUESTS;
  const now = options.now ?? Date.now;
  const hitsByKey = new Map<string, number[]>();
  let lastSweep = 0;

  // Periodically drop keys whose hits have all aged out so a stream of unique
  // spoofable IPs can't grow the map without bound.
  function sweep(currentTime: number) {
    if (currentTime - lastSweep < windowMs) return;
    lastSweep = currentTime;
    const cutoff = currentTime - windowMs;
    for (const [key, hits] of hitsByKey) {
      const recent = hits.filter((hit) => hit > cutoff);
      if (recent.length === 0) hitsByKey.delete(key);
      else hitsByKey.set(key, recent);
    }
  }

  return {
    consume(ip: string) {
      const currentTime = now();
      sweep(currentTime);
      const cutoff = currentTime - windowMs;
      const key = ip || "unknown";
      const recentHits = (hitsByKey.get(key) ?? []).filter((hit) => hit > cutoff);

      if (recentHits.length >= maxRequests) {
        const oldestHit = recentHits[0] ?? currentTime;
        hitsByKey.set(key, recentHits);
        return {
          allowed: false,
          limit: maxRequests,
          remaining: 0,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((oldestHit + windowMs - currentTime) / 1000),
          ),
        };
      }

      recentHits.push(currentTime);
      hitsByKey.set(key, recentHits);
      return {
        allowed: true,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - recentHits.length),
        retryAfterSeconds: 0,
      };
    },
  };
}

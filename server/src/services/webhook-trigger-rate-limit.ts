/**
 * In-memory sliding-window rate limiter for the public, unauthenticated
 * routine webhook-fire endpoint (`POST /api/routine-triggers/public/:publicId/fire`).
 *
 * Signature verification alone doesn't protect against cost/billing abuse:
 * a caller who knows a valid `publicId` (or a `none`-signed trigger's URL)
 * can otherwise fire a routine as fast as the network allows, each firing
 * potentially creating an issue and waking an agent. Two independent
 * buckets are enforced:
 *  - per publicId: caps the blast radius of a single leaked/guessed trigger
 *  - per client IP: caps a single source sweeping across many publicIds
 *
 * Same sliding-window shape as `company-search-rate-limit.ts`, kept as a
 * separate small implementation since this endpoint has a different key
 * space (unauthenticated, keyed by trigger + IP rather than company actor).
 */
export const WEBHOOK_TRIGGER_RATE_LIMIT_WINDOW_MS = 60_000;
export const WEBHOOK_TRIGGER_RATE_LIMIT_MAX_PER_TRIGGER = 30;
export const WEBHOOK_TRIGGER_RATE_LIMIT_MAX_PER_IP = 120;

export type WebhookTriggerRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export type WebhookTriggerRateLimiter = {
  consume(publicId: string, clientIp: string): WebhookTriggerRateLimitResult;
};

function createSlidingWindowBucket(options: { windowMs: number; maxRequests: number; now: () => number }) {
  const hitsByKey = new Map<string, number[]>();
  return {
    consume(key: string): WebhookTriggerRateLimitResult {
      const currentTime = options.now();
      const cutoff = currentTime - options.windowMs;
      const recentHits = (hitsByKey.get(key) ?? []).filter((hit) => hit > cutoff);

      if (recentHits.length >= options.maxRequests) {
        const oldestHit = recentHits[0] ?? currentTime;
        hitsByKey.set(key, recentHits);
        return {
          allowed: false,
          limit: options.maxRequests,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((oldestHit + options.windowMs - currentTime) / 1000)),
        };
      }

      recentHits.push(currentTime);
      hitsByKey.set(key, recentHits);
      return {
        allowed: true,
        limit: options.maxRequests,
        remaining: Math.max(0, options.maxRequests - recentHits.length),
        retryAfterSeconds: 0,
      };
    },
  };
}

export function createWebhookTriggerRateLimiter(options: {
  windowMs?: number;
  maxPerTrigger?: number;
  maxPerIp?: number;
  now?: () => number;
} = {}): WebhookTriggerRateLimiter {
  const windowMs = options.windowMs ?? WEBHOOK_TRIGGER_RATE_LIMIT_WINDOW_MS;
  const now = options.now ?? Date.now;
  const perTrigger = createSlidingWindowBucket({
    windowMs,
    maxRequests: options.maxPerTrigger ?? WEBHOOK_TRIGGER_RATE_LIMIT_MAX_PER_TRIGGER,
    now,
  });
  const perIp = createSlidingWindowBucket({
    windowMs,
    maxRequests: options.maxPerIp ?? WEBHOOK_TRIGGER_RATE_LIMIT_MAX_PER_IP,
    now,
  });

  return {
    consume(publicId, clientIp) {
      const triggerResult = perTrigger.consume(`trigger:${publicId}`);
      if (!triggerResult.allowed) return triggerResult;
      const ipResult = perIp.consume(`ip:${clientIp}`);
      if (!ipResult.allowed) return ipResult;
      return triggerResult.remaining <= ipResult.remaining ? triggerResult : ipResult;
    },
  };
}

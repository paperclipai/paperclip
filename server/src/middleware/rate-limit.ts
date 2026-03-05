import type { Request, RequestHandler } from "express";

type Bucket = {
  count: number;
  resetAtMs: number;
};

export interface RateLimitOptions {
  name: string;
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
  skip?: (req: Request) => boolean;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function resolveClientIp(req: Request): string {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function defaultRateLimitKey(req: Request): string {
  if (req.actor.type === "agent" && req.actor.agentId) {
    return `agent:${req.actor.agentId}`;
  }
  if (req.actor.type === "board" && req.actor.userId) {
    return `user:${req.actor.userId}`;
  }
  return `ip:${resolveClientIp(req)}`;
}

export function createRateLimitMiddleware(opts: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const windowMs = Math.max(1000, opts.windowMs);
  const max = Math.max(1, opts.max);
  const keyResolver = opts.key ?? defaultRateLimitKey;

  return (req, res, next) => {
    if (opts.skip?.(req)) {
      next();
      return;
    }

    const now = Date.now();
    const key = `${opts.name}:${keyResolver(req)}`;
    const existing = buckets.get(key);
    let bucket: Bucket;
    if (!existing || now >= existing.resetAtMs) {
      bucket = {
        count: 0,
        resetAtMs: now + windowMs,
      };
    } else {
      bucket = existing;
    }

    bucket.count += 1;
    buckets.set(key, bucket);

    const remaining = Math.max(0, max - bucket.count);
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAtMs - now) / 1000));

    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.floor(bucket.resetAtMs / 1000)));

    if (bucket.count > max) {
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        error: "Rate limit exceeded",
        code: "rate_limited",
        scope: opts.name,
        retryAfterSec,
      });
      return;
    }

    if (buckets.size > 5000) {
      for (const [bucketKey, value] of buckets) {
        if (value.resetAtMs <= now) buckets.delete(bucketKey);
      }
    }

    next();
  };
}

export function buildRateLimitConfigFromEnv() {
  return {
    enabled: process.env.PAPERCLIP_RATE_LIMIT_ENABLED !== "false",
    globalWindowMs: parsePositiveInt(process.env.PAPERCLIP_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
    globalMax: parsePositiveInt(process.env.PAPERCLIP_RATE_LIMIT_MAX, 100),
    authWindowMs: parsePositiveInt(process.env.PAPERCLIP_AUTH_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
    authMax: parsePositiveInt(process.env.PAPERCLIP_AUTH_RATE_LIMIT_MAX, 30),
    resetWindowMs: parsePositiveInt(process.env.PAPERCLIP_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
    resetMax: parsePositiveInt(process.env.PAPERCLIP_PASSWORD_RESET_RATE_LIMIT_MAX, 3),
  };
}

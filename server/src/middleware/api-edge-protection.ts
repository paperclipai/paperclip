import type { RequestHandler } from "express";

const MINUTE_MS = 60_000;
const LOG_ENDPOINT_LIMIT_PER_MINUTE = 100;
const DEFAULT_ENDPOINT_LIMIT_PER_MINUTE = 300;
const DEFAULT_TIMEOUT_MS = 15_000;
const LOG_ENDPOINT_TIMEOUT_MS = 60_000;

type RateLimitBucket = {
  hits: number[];
};

function normalizePath(path: string): string {
  if (path.startsWith("/api/")) return path.slice(4);
  if (path === "/api") return "/";
  return path;
}

function isLogPath(path: string): boolean {
  const normalizedPath = normalizePath(path);
  return (
    /^\/heartbeat-runs\/[^/]+\/log(?:\/|$)/.test(normalizedPath) ||
    /^\/workspace-operations\/[^/]+\/log(?:\/|$)/.test(normalizedPath)
  );
}

function isLocalIp(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return false;
}

export function createApiRateLimitMiddleware(options: {
  now?: () => number;
  windowMs?: number;
  logLimitPerMinute?: number;
  defaultLimitPerMinute?: number;
} = {}): RequestHandler {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? MINUTE_MS;
  const logLimitPerMinute = options.logLimitPerMinute ?? LOG_ENDPOINT_LIMIT_PER_MINUTE;
  const defaultLimitPerMinute = options.defaultLimitPerMinute ?? DEFAULT_ENDPOINT_LIMIT_PER_MINUTE;
  const buckets = new Map<string, RateLimitBucket>();

  return (req, res, next) => {
    const path = req.path;
    if (!(path === "/api" || path.startsWith("/api/") || path.startsWith("/heartbeat-runs/") || path.startsWith("/workspace-operations/"))) {
      next();
      return;
    }
    if (isLocalIp(req.ip)) {
      next();
      return;
    }

    const limit = isLogPath(path) ? logLimitPerMinute : defaultLimitPerMinute;
    const timestamp = now();
    const cutoff = timestamp - windowMs;
    const ipKey = `${req.ip || "unknown"}:${isLogPath(path) ? "log" : "default"}`;
    const bucket = buckets.get(ipKey) ?? { hits: [] };
    bucket.hits = bucket.hits.filter((hit) => hit > cutoff);

    if (bucket.hits.length >= limit) {
      const oldestHit = bucket.hits[0] ?? timestamp;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestHit + windowMs - timestamp) / 1000));
      buckets.set(ipKey, bucket);
      res.setHeader("X-RateLimit-Limit", String(limit));
      res.setHeader("X-RateLimit-Remaining", "0");
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "Rate limit exceeded",
        retryAfterSeconds,
      });
      return;
    }

    bucket.hits.push(timestamp);
    buckets.set(ipKey, bucket);
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - bucket.hits.length)));
    next();
  };
}

export function createApiTimeoutMiddleware(options: {
  defaultTimeoutMs?: number;
  logEndpointTimeoutMs?: number;
} = {}): RequestHandler {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logEndpointTimeoutMs = options.logEndpointTimeoutMs ?? LOG_ENDPOINT_TIMEOUT_MS;
  return (req, res, next) => {
    const path = req.path;
    if (!(path === "/api" || path.startsWith("/api/") || path.startsWith("/heartbeat-runs/") || path.startsWith("/workspace-operations/"))) {
      next();
      return;
    }
    const timeoutMs = isLogPath(path) ? logEndpointTimeoutMs : defaultTimeoutMs;

    req.setTimeout(timeoutMs);
    res.setTimeout(timeoutMs, () => {
      if (res.headersSent) return;
      res.status(503).json({
        error: "Request timeout",
        timeoutMs,
      });
    });
    next();
  };
}

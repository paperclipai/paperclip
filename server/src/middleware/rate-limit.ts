import type { RequestHandler } from "express";

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

export function apiRateLimit(opts: {
  windowMs: number;
  max: number;
}): RequestHandler {
  const store = new Map<string, RateLimitRecord>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of store) {
      if (now > record.resetTime) store.delete(key);
    }
  }, 60_000).unref();

  return (req, res, next) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    let record = store.get(key);

    if (!record || now > record.resetTime) {
      record = { count: 0, resetTime: now + opts.windowMs };
      store.set(key, record);
    }

    record.count++;

    res.set("X-RateLimit-Limit", String(opts.max));
    res.set("X-RateLimit-Remaining", String(Math.max(0, opts.max - record.count)));

    if (record.count > opts.max) {
      res.status(429).json({ error: "Too many requests, please try again later." });
      return;
    }

    next();
  };
}

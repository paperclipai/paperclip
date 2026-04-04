import rateLimit from "express-rate-limit";

export interface RateLimitConfig {
  authMax: number;
  writeMax: number;
  readMax: number;
}

export function createRateLimiters(config: RateLimitConfig) {
  const authLimiter = rateLimit({
    windowMs: 60_000,
    max: config.authMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });

  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: config.writeMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
    message: { error: "Too many requests, please try again later" },
  });

  const readLimiter = rateLimit({
    windowMs: 60_000,
    max: config.readMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method !== "GET",
    message: { error: "Too many requests, please try again later" },
  });

  return { authLimiter, writeLimiter, readLimiter };
}

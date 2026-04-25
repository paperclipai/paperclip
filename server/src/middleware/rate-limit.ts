import type { Request, Response, NextFunction } from "express";

function createRateLimit(windowMs: number, max: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (entry.count >= max) {
      res.status(429).json({ error: "Too many requests, please try again later." });
      return;
    }

    entry.count++;
    next();
  };
}

export const webhookRateLimit = createRateLimit(60_000, 30);
export const apiRateLimit = createRateLimit(60_000, 60);

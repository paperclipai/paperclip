import rateLimit from "express-rate-limit";
import type { Store } from "express-rate-limit";
import type { RequestHandler } from "express";

function parseEnvInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

let redisClientPromise: Promise<any> | null = null;

async function getRedisClient(): Promise<any | undefined> {
  const redisUrl = process.env.PAPERCLIP_RATE_LIMIT_REDIS_URL;
  if (!redisUrl) return undefined;

  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const ioredis = await import("ioredis");
      const Redis = ioredis.default ?? ioredis;
      return new (Redis as any)(redisUrl);
    })();
  }
  return redisClientPromise;
}

async function createRedisStore(prefix: string): Promise<Store | undefined> {
  const client = await getRedisClient();
  if (!client) return undefined;
  const { RedisStore } = await import("rate-limit-redis");
  return new RedisStore({ sendCommand: (...args: string[]) => client.call(...args) as any, prefix });
}

/** Global rate limit — applied to all requests. */
export async function createGlobalRateLimit(): Promise<RequestHandler> {
  const store = await createRedisStore("rl:global:");
  return rateLimit({
    windowMs: 60_000,
    limit: parseEnvInt("PAPERCLIP_RATE_LIMIT_GLOBAL", 100_000),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
    ...(store ? { store } : {}),
  });
}

/** Strict rate limit for authentication endpoints. */
export async function createAuthRateLimit(): Promise<RequestHandler> {
  const store = await createRedisStore("rl:auth:");
  return rateLimit({
    windowMs: 60_000,
    limit: parseEnvInt("PAPERCLIP_RATE_LIMIT_AUTH", 20),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many authentication attempts, please try again later" },
    ...(store ? { store } : {}),
    keyGenerator: (req) => {
      return req.ip ?? req.socket.remoteAddress ?? "unknown";
    },
  });
}

/** Rate limit for public webhook endpoints. */
export async function createWebhookRateLimit(): Promise<RequestHandler> {
  const store = await createRedisStore("rl:webhook:");
  return rateLimit({
    windowMs: 60_000,
    limit: parseEnvInt("PAPERCLIP_RATE_LIMIT_WEBHOOK", 100),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many webhook requests, please try again later" },
    ...(store ? { store } : {}),
  });
}

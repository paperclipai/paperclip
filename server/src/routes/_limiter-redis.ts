import { randomBytes } from "node:crypto";
import type { SlidingWindowLimiter } from "./_limiter-types.js";

/**
 * Atomic sliding-window rate-limit step:
 *   1. Drop members older than (now - windowMs).
 *   2. If remaining count >= max, return {allowed=0, retryAfterMs}.
 *   3. Else add a unique member at score=now, refresh PEXPIRE, return allowed=1.
 *
 * KEYS[1] = redis sorted set
 * ARGV    = nowMs, windowMs, max, uniqueNonce
 * Result  = [ allowed (0|1), retryAfterMs ]
 */
const LUA_CONSUME = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local nonce = ARGV[4]
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)
local count = redis.call('ZCARD', KEYS[1])
if count >= max then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retry = tonumber(oldest[2]) + windowMs - now
  if retry < 1 then retry = 1 end
  return { 0, retry }
end
redis.call('ZADD', KEYS[1], now, nonce)
redis.call('PEXPIRE', KEYS[1], windowMs * 2)
return { 1, 0 }
`;

export interface RedisLikeClient {
  eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown>;
  quit?: () => Promise<unknown>;
}

export interface CreateRedisSlidingWindowLimiterOpts {
  client: RedisLikeClient;
  /** Namespace component baked into the Redis key (e.g. "exchange", "events"). */
  name: string;
  windowMs: number;
  max: number;
}

export function createRedisSlidingWindowLimiter(
  opts: CreateRedisSlidingWindowLimiterOpts,
): SlidingWindowLimiter {
  return {
    async consume(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
      const now = Date.now();
      const nonce = `${now}:${randomBytes(6).toString("hex")}`;
      try {
        const raw = (await opts.client.eval(LUA_CONSUME, {
          keys: [`paperclip:rl:${opts.name}:${key}`],
          arguments: [String(now), String(opts.windowMs), String(opts.max), nonce],
        })) as [number, number] | string[];
        // ioredis-mock returns string[]; redis@4 returns number[]. Coerce.
        const allowed = Number(Array.isArray(raw) ? raw[0] : 0) === 1;
        const retryMs = Number(Array.isArray(raw) ? raw[1] : 0);
        return { allowed, retryAfterSeconds: Math.max(0, Math.ceil(retryMs / 1000)) };
      } catch {
        // Fail open on Redis blips: better to admit a request that should
        // have been throttled than 500 the entire endpoint when Redis is
        // unreachable. The endpoint logs the upstream error separately.
        return { allowed: true, retryAfterSeconds: 0 };
      }
    },
    async stop() {
      // We don't own the client — caller is responsible for the Redis
      // connection lifecycle. stop() exists to satisfy the interface.
    },
  };
}

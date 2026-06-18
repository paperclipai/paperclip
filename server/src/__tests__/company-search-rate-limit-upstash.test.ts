import { describe, expect, it } from "vitest";
import { createUpstashCompanySearchRateLimiter } from "../services/company-search-rate-limit-upstash.js";
import type {
  RateLimitRedisClient,
  RateLimitRedisPipeline,
} from "../services/company-search-rate-limit-upstash.js";
import type { CompanySearchRateLimitActor } from "../services/company-search-rate-limit.js";

type Entry = { value: number; expireAt: number | null };

/**
 * In-memory fake of the Upstash client honoring INCR, PEXPIRE ... NX, and PTTL with a
 * manually advanced clock so window-reset behavior is deterministic.
 */
function createFakeRedis(options: { clock: { now: number }; failOnExec?: boolean }): RateLimitRedisClient {
  const store = new Map<string, Entry>();

  function live(key: string): Entry | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expireAt !== null && entry.expireAt <= options.clock.now) {
      store.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    pipeline(): RateLimitRedisPipeline {
      const ops: Array<() => number> = [];
      const pipeline: RateLimitRedisPipeline = {
        incr(key: string) {
          ops.push(() => {
            const entry = live(key) ?? { value: 0, expireAt: null };
            entry.value += 1;
            store.set(key, entry);
            return entry.value;
          });
          return pipeline;
        },
        pexpire(key: string, ms: number, option?: "NX") {
          ops.push(() => {
            const entry = live(key);
            if (!entry) return 0;
            if (option === "NX" && entry.expireAt !== null) return 0;
            entry.expireAt = options.clock.now + ms;
            return 1;
          });
          return pipeline;
        },
        pttl(key: string) {
          ops.push(() => {
            const entry = live(key);
            if (!entry) return -2;
            if (entry.expireAt === null) return -1;
            return entry.expireAt - options.clock.now;
          });
          return pipeline;
        },
        async exec<TResults extends unknown[] = unknown[]>() {
          if (options.failOnExec) throw new Error("redis unavailable");
          return ops.map((op) => op()) as TResults;
        },
      };
      return pipeline;
    },
  };
}

const actor: CompanySearchRateLimitActor = {
  companyId: "company-1",
  actorType: "board",
  actorId: "user-1",
};

describe("upstash company search rate limiter", () => {
  it("allows up to the max then blocks within the window", async () => {
    const clock = { now: 1_000 };
    const limiter = createUpstashCompanySearchRateLimiter({
      redis: createFakeRedis({ clock }),
      windowMs: 60_000,
      maxRequests: 2,
    });

    const first = await limiter.consume(actor);
    const second = await limiter.consume(actor);
    const third = await limiter.consume(actor);

    expect(first).toMatchObject({ allowed: true, remaining: 1 });
    expect(second).toMatchObject({ allowed: true, remaining: 0 });
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBe(60);
  });

  it("resets the counter after the window TTL expires", async () => {
    const clock = { now: 1_000 };
    const limiter = createUpstashCompanySearchRateLimiter({
      redis: createFakeRedis({ clock }),
      windowMs: 60_000,
      maxRequests: 1,
    });

    expect((await limiter.consume(actor)).allowed).toBe(true);
    expect((await limiter.consume(actor)).allowed).toBe(false);

    clock.now += 60_001; // window elapses
    expect((await limiter.consume(actor)).allowed).toBe(true);
  });

  it("keeps independent counters per actor", async () => {
    const clock = { now: 1_000 };
    const limiter = createUpstashCompanySearchRateLimiter({
      redis: createFakeRedis({ clock }),
      windowMs: 60_000,
      maxRequests: 1,
    });

    expect((await limiter.consume(actor)).allowed).toBe(true);
    const otherActor = { ...actor, actorId: "user-2" };
    expect((await limiter.consume(otherActor)).allowed).toBe(true);
    expect((await limiter.consume(actor)).allowed).toBe(false);
  });

  it("fails closed (blocks) when Redis is unavailable by default", async () => {
    const clock = { now: 1_000 };
    const limiter = createUpstashCompanySearchRateLimiter({
      redis: createFakeRedis({ clock, failOnExec: true }),
      windowMs: 60_000,
      maxRequests: 60,
    });

    const result = await limiter.consume(actor);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("fails open (allows) when explicitly configured", async () => {
    const clock = { now: 1_000 };
    const limiter = createUpstashCompanySearchRateLimiter({
      redis: createFakeRedis({ clock, failOnExec: true }),
      windowMs: 60_000,
      maxRequests: 60,
      failClosed: false,
    });

    const result = await limiter.consume(actor);
    expect(result.allowed).toBe(true);
  });
});

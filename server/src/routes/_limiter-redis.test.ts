import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RedisMock from "ioredis-mock";
import { createRedisSlidingWindowLimiter } from "./_limiter-redis.js";

// ioredis-mock shares an in-process data store across all instances in the
// same module. We keep a single mock and flush it between tests so each test
// starts with an empty data store.
const sharedMock = new RedisMock();

// We use ioredis-mock + a thin shim so the redis@4 client interface our
// production code uses is satisfied at the test boundary.
function makeShimClient(): { client: any; mock: any } {
  const mock = sharedMock;
  const client = {
    eval: async (script: string, opts: { keys: string[]; arguments: string[] }) => {
      // ioredis-mock supports `eval(script, numKeys, ...keys, ...args)`.
      // Translate the redis@4 shape (keys[]+arguments[]) to that.
      return mock.eval(script, opts.keys.length, ...opts.keys, ...opts.arguments);
    },
    quit: async () => mock.quit(),
  };
  return { client, mock };
}

describe("createRedisSlidingWindowLimiter", () => {
  let now = 1_700_000_000_000;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    // Flush shared mock state so each test starts clean.
    await sharedMock.flushall();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to max requests in the window, then denies", async () => {
    const { client } = makeShimClient();
    const limiter = createRedisSlidingWindowLimiter({
      client, name: "exchange", windowMs: 60_000, max: 3,
    });
    for (let i = 0; i < 3; i++) {
      const r = await limiter.consume("ip:1.2.3.4");
      expect(r.allowed).toBe(true);
    }
    const denied = await limiter.consume("ip:1.2.3.4");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    await limiter.stop();
  });

  it("forgets old hits past the window boundary", async () => {
    const { client } = makeShimClient();
    const limiter = createRedisSlidingWindowLimiter({
      client, name: "exchange", windowMs: 60_000, max: 1,
    });
    expect((await limiter.consume("ip:1.2.3.4")).allowed).toBe(true);
    expect((await limiter.consume("ip:1.2.3.4")).allowed).toBe(false);
    // Advance past the window.
    vi.setSystemTime(now + 61_000);
    expect((await limiter.consume("ip:1.2.3.4")).allowed).toBe(true);
    await limiter.stop();
  });

  it("isolates buckets per key", async () => {
    const { client } = makeShimClient();
    const limiter = createRedisSlidingWindowLimiter({
      client, name: "exchange", windowMs: 60_000, max: 1,
    });
    expect((await limiter.consume("ip:1.1.1.1")).allowed).toBe(true);
    expect((await limiter.consume("ip:2.2.2.2")).allowed).toBe(true);
    expect((await limiter.consume("ip:1.1.1.1")).allowed).toBe(false);
    await limiter.stop();
  });

  it("isolates buckets per limiter name", async () => {
    const { client } = makeShimClient();
    const a = createRedisSlidingWindowLimiter({ client, name: "exchange", windowMs: 60_000, max: 1 });
    const b = createRedisSlidingWindowLimiter({ client, name: "events",   windowMs: 60_000, max: 1 });
    expect((await a.consume("k")).allowed).toBe(true);
    expect((await b.consume("k")).allowed).toBe(true);
    expect((await a.consume("k")).allowed).toBe(false);
    expect((await b.consume("k")).allowed).toBe(false);
    await a.stop(); await b.stop();
  });
});

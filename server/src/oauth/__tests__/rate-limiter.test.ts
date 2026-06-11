import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSlidingWindowLimiter } from "../rate-limiter.js";

describe("createSlidingWindowLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows up to limit then blocks", async () => {
    const limit = createSlidingWindowLimiter({ limit: 3, windowMs: 60_000 });
    expect(await limit.check("k1")).toBe(true);
    expect(await limit.check("k1")).toBe(true);
    expect(await limit.check("k1")).toBe(true);
    expect(await limit.check("k1")).toBe(false);
  });

  it("scopes by key", async () => {
    const limit = createSlidingWindowLimiter({ limit: 1, windowMs: 60_000 });
    expect(await limit.check("a")).toBe(true);
    expect(await limit.check("b")).toBe(true);
    expect(await limit.check("a")).toBe(false);
  });

  it("expires entries after window", async () => {
    const limit = createSlidingWindowLimiter({ limit: 1, windowMs: 60_000 });
    expect(await limit.check("k")).toBe(true);
    expect(await limit.check("k")).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(await limit.check("k")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { createWebhookTriggerRateLimiter } from "../services/webhook-trigger-rate-limit.js";

describe("webhook trigger rate limiter", () => {
  it("allows requests under the per-trigger limit and blocks once exceeded", () => {
    let now = 0;
    const limiter = createWebhookTriggerRateLimiter({
      windowMs: 60_000,
      maxPerTrigger: 3,
      maxPerIp: 100,
      now: () => now,
    });

    expect(limiter.consume("trigger-a", "1.2.3.4").allowed).toBe(true);
    expect(limiter.consume("trigger-a", "1.2.3.4").allowed).toBe(true);
    expect(limiter.consume("trigger-a", "1.2.3.4").allowed).toBe(true);

    const blocked = limiter.consume("trigger-a", "1.2.3.4");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("scopes the per-trigger bucket independently for different publicIds", () => {
    let now = 0;
    const limiter = createWebhookTriggerRateLimiter({
      windowMs: 60_000,
      maxPerTrigger: 1,
      maxPerIp: 100,
      now: () => now,
    });

    expect(limiter.consume("trigger-a", "1.2.3.4").allowed).toBe(true);
    expect(limiter.consume("trigger-a", "1.2.3.4").allowed).toBe(false);
    // A different trigger has its own bucket even from the same IP.
    expect(limiter.consume("trigger-b", "1.2.3.4").allowed).toBe(true);
  });

  it("blocks a single IP sweeping across many publicIds via the per-IP bucket", () => {
    let now = 0;
    const limiter = createWebhookTriggerRateLimiter({
      windowMs: 60_000,
      maxPerTrigger: 1000,
      maxPerIp: 2,
      now: () => now,
    });

    expect(limiter.consume("trigger-a", "1.2.3.4").allowed).toBe(true);
    expect(limiter.consume("trigger-b", "1.2.3.4").allowed).toBe(true);
    // Third distinct trigger, same IP — the IP bucket is now exhausted.
    expect(limiter.consume("trigger-c", "1.2.3.4").allowed).toBe(false);
    // A different IP is unaffected.
    expect(limiter.consume("trigger-d", "5.6.7.8").allowed).toBe(true);
  });

  it("evicts fully-expired keys instead of retaining every key seen forever", () => {
    let now = 0;
    const limiter = createWebhookTriggerRateLimiter({
      windowMs: 1_000,
      maxPerTrigger: 5,
      maxPerIp: 5,
      now: () => now,
    });

    // Sweep across many distinct triggers — each is only hit once, so a
    // naive implementation would leak one map entry per trigger forever.
    for (let i = 0; i < 500; i += 1) {
      limiter.consume(`trigger-${i}`, "1.2.3.4");
    }

    // Advance past the window and beyond the next sweep threshold, then
    // make one more request to trigger the lazy sweep.
    now += 2_500;
    limiter.consume("trigger-fresh", "5.6.7.8");

    // The old per-trigger keys should no longer count toward any limit —
    // observable behavior: firing the very first trigger again is allowed
    // at full capacity again, not treated as already having a stale hit.
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.consume("trigger-0", "9.9.9.9").allowed).toBe(true);
    }
    expect(limiter.consume("trigger-0", "9.9.9.9").allowed).toBe(false);
  });

  it("resets once the sliding window elapses", () => {
    let now = 0;
    const limiter = createWebhookTriggerRateLimiter({
      windowMs: 1_000,
      maxPerTrigger: 1,
      maxPerIp: 100,
      now: () => now,
    });

    expect(limiter.consume("trigger-a", "1.2.3.4").allowed).toBe(true);
    expect(limiter.consume("trigger-a", "1.2.3.4").allowed).toBe(false);

    now += 1_001;
    expect(limiter.consume("trigger-a", "1.2.3.4").allowed).toBe(true);
  });
});

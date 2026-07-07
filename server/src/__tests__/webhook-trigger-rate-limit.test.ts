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

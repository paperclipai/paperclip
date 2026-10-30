import { describe, expect, it } from "vitest";
import { createInviteRateLimiter } from "../services/invite-rate-limit.js";

describe("createInviteRateLimiter", () => {
  it("allows requests up to the limit then blocks with a retry-after", () => {
    const limiter = createInviteRateLimiter({
      maxRequests: 3,
      windowMs: 60_000,
      now: () => 1_000,
    });

    expect(limiter.consume("1.2.3.4").allowed).toBe(true);
    expect(limiter.consume("1.2.3.4").allowed).toBe(true);
    expect(limiter.consume("1.2.3.4").allowed).toBe(true);

    const blocked = limiter.consume("1.2.3.4");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBe(60);
  });

  it("tracks each IP independently", () => {
    const limiter = createInviteRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      now: () => 1_000,
    });

    expect(limiter.consume("1.1.1.1").allowed).toBe(true);
    expect(limiter.consume("1.1.1.1").allowed).toBe(false);
    expect(limiter.consume("2.2.2.2").allowed).toBe(true);
  });

  it("forgets hits once the window has elapsed", () => {
    let current = 1_000;
    const limiter = createInviteRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      now: () => current,
    });

    expect(limiter.consume("9.9.9.9").allowed).toBe(true);
    expect(limiter.consume("9.9.9.9").allowed).toBe(false);
    current += 60_001;
    expect(limiter.consume("9.9.9.9").allowed).toBe(true);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TOKENS_REMAINING_THRESHOLD,
  __setQuotaStateForTests,
  getActivePause,
  parseAnthropicRateLimitHeaders,
} from "./quota-guard.js";

afterEach(() => {
  __setQuotaStateForTests(null);
});

describe("parseAnthropicRateLimitHeaders", () => {
  it("parses tokens-remaining, reset, and retry-after from a plain header map", () => {
    const now = new Date("2026-06-15T18:00:00.000Z");
    const result = parseAnthropicRateLimitHeaders(
      {
        "anthropic-ratelimit-tokens-remaining": "1234",
        "anthropic-ratelimit-tokens-reset": "2026-06-15T18:30:00Z",
        "retry-after": "60",
      },
      now,
    );

    expect(result.tokensRemaining).toBe(1234);
    expect(result.resetAt?.toISOString()).toBe("2026-06-15T18:30:00.000Z");
    expect(result.retryAfterAt?.toISOString()).toBe("2026-06-15T18:01:00.000Z");
  });

  it("treats retry-after as an HTTP-date when not numeric", () => {
    const now = new Date("2026-06-15T18:00:00.000Z");
    const result = parseAnthropicRateLimitHeaders(
      { "retry-after": "2026-06-15T19:00:00Z" },
      now,
    );
    expect(result.retryAfterAt?.toISOString()).toBe("2026-06-15T19:00:00.000Z");
  });

  it("returns nulls for missing or malformed headers", () => {
    const result = parseAnthropicRateLimitHeaders({});
    expect(result.tokensRemaining).toBeNull();
    expect(result.resetAt).toBeNull();
    expect(result.retryAfterAt).toBeNull();

    const malformed = parseAnthropicRateLimitHeaders({
      "anthropic-ratelimit-tokens-remaining": "not-a-number",
      "anthropic-ratelimit-tokens-reset": "definitely-not-a-date",
    });
    expect(malformed.tokensRemaining).toBeNull();
    expect(malformed.resetAt).toBeNull();
  });

  it("is case-insensitive on header names", () => {
    const result = parseAnthropicRateLimitHeaders({
      "Anthropic-RateLimit-Tokens-Remaining": "42",
    });
    expect(result.tokensRemaining).toBe(42);
  });

  it("works with a Web Headers instance", () => {
    const h = new Headers({
      "anthropic-ratelimit-tokens-remaining": "9000",
      "anthropic-ratelimit-tokens-reset": "2026-06-15T20:00:00Z",
    });
    const result = parseAnthropicRateLimitHeaders(h);
    expect(result.tokensRemaining).toBe(9000);
    expect(result.resetAt?.toISOString()).toBe("2026-06-15T20:00:00.000Z");
  });
});

describe("getActivePause", () => {
  const now = new Date("2026-06-15T18:00:00.000Z");

  it("returns null when there is no recorded state", () => {
    expect(getActivePause(now)).toBeNull();
  });

  it("returns a pause when retry-after is in the future", () => {
    __setQuotaStateForTests({
      tokensRemaining: null,
      resetAt: null,
      retryAfterAt: new Date("2026-06-15T18:05:00.000Z").toISOString(),
      recordedAt: now.toISOString(),
    });
    const pause = getActivePause(now);
    expect(pause).not.toBeNull();
    expect(pause?.reason).toBe("retry-after");
    expect(pause?.pauseUntil.toISOString()).toBe("2026-06-15T18:05:00.000Z");
  });

  it("returns a pause when remaining tokens are below the threshold and reset is in the future", () => {
    __setQuotaStateForTests({
      tokensRemaining: DEFAULT_TOKENS_REMAINING_THRESHOLD - 1,
      resetAt: new Date("2026-06-15T18:15:00.000Z").toISOString(),
      retryAfterAt: null,
      recordedAt: now.toISOString(),
    });
    const pause = getActivePause(now);
    expect(pause?.reason).toBe("tokens-remaining-below-threshold");
    expect(pause?.pauseUntil.toISOString()).toBe("2026-06-15T18:15:00.000Z");
  });

  it("does not pause when tokens are above threshold", () => {
    __setQuotaStateForTests({
      tokensRemaining: DEFAULT_TOKENS_REMAINING_THRESHOLD + 1,
      resetAt: new Date("2026-06-15T18:15:00.000Z").toISOString(),
      retryAfterAt: null,
      recordedAt: now.toISOString(),
    });
    expect(getActivePause(now)).toBeNull();
  });

  it("does not pause when retry-after lies in the past", () => {
    __setQuotaStateForTests({
      tokensRemaining: null,
      resetAt: null,
      retryAfterAt: new Date("2026-06-15T17:00:00.000Z").toISOString(),
      recordedAt: now.toISOString(),
    });
    expect(getActivePause(now)).toBeNull();
  });

  it("honours a custom token threshold", () => {
    __setQuotaStateForTests({
      tokensRemaining: 1000,
      resetAt: new Date("2026-06-15T18:30:00.000Z").toISOString(),
      retryAfterAt: null,
      recordedAt: now.toISOString(),
    });
    expect(getActivePause(now, 500)).toBeNull();
    expect(getActivePause(now, 5000)?.reason).toBe("tokens-remaining-below-threshold");
  });
});

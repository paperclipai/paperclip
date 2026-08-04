import { describe, expect, it } from "vitest";
import {
  classifyProviderQuota,
  extractProviderQuotaRetryNotBefore,
  isProviderQuotaMessage,
} from "./provider-quota.js";

// The exact string the Claude backend returns through the ACPX engine when a
// session limit is hit; it reached the server classified as a generic turn
// failure, which took recovery down the escalate-immediately branch.
const SESSION_LIMIT_MESSAGE =
  "Internal error: You've hit your session limit · resets 8am (Europe/Moscow)";

describe("isProviderQuotaMessage", () => {
  it("recognises the session-limit refusal", () => {
    expect(isProviderQuotaMessage(SESSION_LIMIT_MESSAGE)).toBe(true);
  });

  it("recognises the other provider quota phrasings", () => {
    for (const message of [
      "Claude usage limit reached",
      "5-hour limit reached · resets 3am",
      "weekly limit reached",
      "You are out of extra usage",
      "ServiceQuotaExceededException",
      "session limit exceeded",
    ]) {
      expect(isProviderQuotaMessage(message), message).toBe(true);
    }
  });

  it("leaves unrelated failures alone", () => {
    for (const message of [
      "ACP turn failed: connection reset by peer",
      "spawn claude ENOENT",
      "model not found",
      "",
      null,
      undefined,
    ]) {
      expect(isProviderQuotaMessage(message), String(message)).toBe(false);
    }
  });
});

describe("extractProviderQuotaRetryNotBefore", () => {
  it("resolves the stated reset against the stated time zone", () => {
    // 03:00Z on 2026-07-27 is 06:00 in Moscow (UTC+3), so "8am" is still ahead
    // today: 08:00 Moscow == 05:00Z.
    const now = new Date("2026-07-27T03:00:00.000Z");
    const retryAt = extractProviderQuotaRetryNotBefore(SESSION_LIMIT_MESSAGE, now);
    expect(retryAt?.toISOString()).toBe("2026-07-27T05:00:00.000Z");
  });

  it("rolls to the next day when the stated reset already passed", () => {
    // 12:00Z is 15:00 in Moscow, so "8am" names tomorrow morning.
    const now = new Date("2026-07-27T12:00:00.000Z");
    const retryAt = extractProviderQuotaRetryNotBefore(SESSION_LIMIT_MESSAGE, now);
    expect(retryAt?.toISOString()).toBe("2026-07-28T05:00:00.000Z");
  });

  it("parses minute-precision resets", () => {
    const now = new Date("2026-07-27T03:00:00.000Z");
    const retryAt = extractProviderQuotaRetryNotBefore(
      "You've hit your session limit · resets 7:50am (Europe/Moscow)",
      now,
    );
    expect(retryAt?.toISOString()).toBe("2026-07-27T04:50:00.000Z");
  });

  it("returns null when the refusal states no reset time", () => {
    expect(extractProviderQuotaRetryNotBefore("Claude usage limit reached")).toBeNull();
  });
});

describe("classifyProviderQuota", () => {
  it("classifies the session limit with its reset instant", () => {
    const now = new Date("2026-07-27T03:00:00.000Z");
    expect(classifyProviderQuota(SESSION_LIMIT_MESSAGE, now)).toEqual({
      retryNotBefore: new Date("2026-07-27T05:00:00.000Z"),
    });
  });

  it("still classifies a quota refusal that states no reset time", () => {
    // The family alone is what routes recovery to wait-and-retry; losing it
    // because the provider omitted a clock time would drop the run back onto
    // the escalate-immediately path.
    expect(classifyProviderQuota("Claude usage limit reached")).toEqual({
      retryNotBefore: null,
    });
  });

  it("returns null for a non-quota failure", () => {
    expect(classifyProviderQuota("ACP turn failed: connection reset by peer")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  classifyProviderQuotaFailure,
  isProviderQuotaMessage,
  parseProviderQuotaRetryNotBefore,
} from "./provider-quota.js";

// Verbatim terminal message from a Claude session-limit refusal surfaced through
// the ACP protocol path, where no adapter stdout exists to classify against.
const SESSION_LIMIT_MESSAGE =
  "Internal error: You've hit your session limit · resets 8am (Europe/Moscow)";

describe("isProviderQuotaMessage", () => {
  it("matches a session limit refusal", () => {
    expect(isProviderQuotaMessage(SESSION_LIMIT_MESSAGE)).toBe(true);
  });

  it("matches the typographic apostrophe variant", () => {
    expect(isProviderQuotaMessage("You’ve hit your session limit")).toBe(true);
  });

  it("matches usage-limit phrasings", () => {
    expect(isProviderQuotaMessage("Claude usage limit reached")).toBe(true);
    expect(isProviderQuotaMessage("weekly limit reached")).toBe(true);
    expect(isProviderQuotaMessage("ServiceQuotaExceededException")).toBe(true);
  });

  it("does not match unrelated turn failures", () => {
    expect(isProviderQuotaMessage("ACP_TURN_FAILED: connection reset by peer")).toBe(false);
    expect(isProviderQuotaMessage("tool use limit exceeded for this turn")).toBe(false);
    expect(isProviderQuotaMessage(null)).toBe(false);
    expect(isProviderQuotaMessage("")).toBe(false);
  });
});

describe("parseProviderQuotaRetryNotBefore", () => {
  it("resolves the advertised reset in the zone named by the message", () => {
    // 2026-07-27T00:30Z is 03:30 in Europe/Moscow (UTC+3), so 8am resets the same day.
    const now = new Date("2026-07-27T00:30:00.000Z");
    const retryAt = parseProviderQuotaRetryNotBefore(SESSION_LIMIT_MESSAGE, now);
    expect(retryAt?.toISOString()).toBe("2026-07-27T05:00:00.000Z");
  });

  it("rolls to the next day when the reset hour already passed", () => {
    // 09:00 Moscow is past 8am, so the next reset is tomorrow.
    const now = new Date("2026-07-27T06:00:00.000Z");
    const retryAt = parseProviderQuotaRetryNotBefore(SESSION_LIMIT_MESSAGE, now);
    expect(retryAt?.toISOString()).toBe("2026-07-28T05:00:00.000Z");
  });

  it("returns null when the message advertises no reset time", () => {
    expect(parseProviderQuotaRetryNotBefore("You've hit your session limit")).toBeNull();
  });
});

describe("classifyProviderQuotaFailure", () => {
  it("classifies a session limit refusal as provider quota with a reset instant", () => {
    const now = new Date("2026-07-27T00:30:00.000Z");
    expect(classifyProviderQuotaFailure(SESSION_LIMIT_MESSAGE, now)).toEqual({
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: "2026-07-27T05:00:00.000Z",
    });
  });

  it("classifies a quota refusal without a reset hint", () => {
    expect(classifyProviderQuotaFailure("out of extra usage")).toEqual({
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: null,
    });
  });

  it("leaves other failures unclassified", () => {
    expect(classifyProviderQuotaFailure("ACP_TURN_FAILED: connection reset by peer")).toBeNull();
  });
});

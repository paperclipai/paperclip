import { describe, expect, it } from "vitest";
import {
  classifyProviderQuotaFailure,
  extractProviderQuotaResetAt,
  matchesProviderQuotaText,
} from "./provider-quota.js";

// The exact sentence a Claude subscription emits when the plan is exhausted.
const WEEKLY_LIMIT_MESSAGE = "You've hit your weekly limit · resets Aug 1 at 10am (Europe/Moscow)";

describe("matchesProviderQuotaText", () => {
  it.each([
    ["Claude weekly limit", WEEKLY_LIMIT_MESSAGE],
    ["5-hour limit", "You've hit your 5-hour limit · resets 3pm (Europe/Moscow)"],
    ["session limit", "You've hit your session limit"],
    ["curly apostrophe", "You’ve hit your weekly limit"],
    ["usage limit reached", "Claude usage limit reached"],
    ["provider quota", "Provider quota exceeded for this model."],
    ["capacity", "The model is at capacity right now."],
  ])("recognises %s", (_label, message) => {
    expect(matchesProviderQuotaText(message)).toBe(true);
  });

  // Reverse control: ordinary failures must keep their own classification.
  it.each([
    ["network reset", "Error: socket hang up while streaming the response"],
    ["tool failure", "Tool 'Bash' failed with exit code 1"],
    ["auth", "Invalid API key. Please run `claude login`."],
    ["model not found", "model claude-imaginary-9 not found"],
    ["empty", ""],
  ])("leaves %s alone", (_label, message) => {
    expect(matchesProviderQuotaText(message)).toBe(false);
  });
});

describe("extractProviderQuotaResetAt", () => {
  it("reads a dated reset with a named zone", () => {
    const now = new Date("2026-07-31T09:00:00.000Z");
    expect(extractProviderQuotaResetAt(WEEKLY_LIMIT_MESSAGE, now)).toEqual(
      new Date("2026-08-01T07:00:00.000Z"),
    );
  });

  it("reads a bare clock reset as the next such time in the named zone", () => {
    const now = new Date("2026-07-31T09:00:00.000Z"); // 12:00 in Moscow
    expect(
      extractProviderQuotaResetAt("You've hit your 5-hour limit · resets 3pm (Europe/Moscow)", now),
    ).toEqual(new Date("2026-07-31T12:00:00.000Z"));
  });

  it("still reads the legacy 'try again at' phrasing", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(
      extractProviderQuotaResetAt(
        "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
        now,
      ),
    ).toEqual(new Date("2026-07-15T21:30:00.000Z"));
  });

  it("rolls a dated reset into the next year across the year boundary", () => {
    const now = new Date("2026-12-31T21:00:00.000Z"); // 2027-01-01 00:00 in Moscow
    expect(
      extractProviderQuotaResetAt(
        "You've hit your weekly limit · resets Jan 2 at 10am (Europe/Moscow)",
        now,
      ),
    ).toEqual(new Date("2027-01-02T07:00:00.000Z"));
  });

  it("honours an explicit year in the reset", () => {
    const now = new Date("2026-07-31T09:00:00.000Z");
    expect(
      extractProviderQuotaResetAt(
        "You've hit your weekly limit · resets Aug 1, 2026 at 10am (Europe/Moscow)",
        now,
      ),
    ).toEqual(new Date("2026-08-01T07:00:00.000Z"));
  });

  it("reads a zoneless clock as UTC when the caller asks for that basis", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(
      extractProviderQuotaResetAt("You've hit your usage limit. Try again at 4:30 PM.", now, {
        zonelessBasis: "utc",
      }),
    ).toEqual(new Date("2026-07-16T16:30:00.000Z"));
  });

  it("returns null when the message states no reset", () => {
    expect(extractProviderQuotaResetAt("You've hit your weekly limit", new Date())).toBeNull();
  });

  it("ignores an unparseable reset spec", () => {
    expect(
      extractProviderQuotaResetAt("You've hit your weekly limit · resets soon", new Date()),
    ).toBeNull();
  });
});

describe("classifyProviderQuotaFailure", () => {
  it("returns the quota family with the stated reset", () => {
    const now = new Date("2026-07-31T09:00:00.000Z");
    expect(classifyProviderQuotaFailure(WEEKLY_LIMIT_MESSAGE, now)).toEqual({
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: "2026-08-01T07:00:00.000Z",
      resetAt: new Date("2026-08-01T07:00:00.000Z"),
    });
  });

  it("returns the quota family without a reset when the message omits one", () => {
    const classification = classifyProviderQuotaFailure("Provider quota exceeded.", new Date());
    expect(classification?.errorFamily).toBe("provider_quota");
    expect(classification?.retryNotBefore).toBeNull();
  });

  it("returns null for an ordinary failure", () => {
    expect(classifyProviderQuotaFailure("Error: socket hang up", new Date())).toBeNull();
  });
});

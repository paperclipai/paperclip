import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
} from "./service.js";

describe("classifyAdapterFailureForRecovery", () => {
  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });

  // Regression: a claude_local run refused by the account-level weekly window
  // reported "You've hit your weekly limit · resets 7pm (Europe/London)". That
  // matched neither the quota wording nor the "try again at" reset clock, so it
  // fell through to the ordinary bounded transient backoff and was replayed
  // every few minutes for the whole length of the window.
  it("classifies the Claude weekly-limit wording and its 'resets' clock", () => {
    const now = new Date("2026-08-04T11:15:16.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your weekly limit · resets 7pm (Europe/London)",
      resultJson: null,
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-04T18:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("classifies the Claude 5-hour-limit wording", () => {
    const now = new Date("2026-08-04T11:15:16.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your 5-hour limit · resets 3pm (UTC)",
      resultJson: null,
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-04T15:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("prefers the adapter's persisted retryNotBefore over the wall-clock prose", () => {
    // The adapter reads the exact epoch off the CLI's structured
    // rate_limit_event; a multi-day window cannot be recovered from prose.
    const now = new Date("2026-08-02T07:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "You've hit your weekly limit · resets 7pm (Europe/London)",
      resultJson: { retryNotBefore: "2026-08-04T18:00:00.000Z" },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-04T18:00:00.000Z"),
      parsedResetTime: true,
    });
  });
});

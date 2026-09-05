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

  it("classifies the qualifier-less limit wording and parses the 'resets' clock", () => {
    // Current Claude CLI phrasing, as recorded on the run by the adapter.
    const now = new Date("2026-08-28T22:30:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Claude run failed: subtype=success: You've hit your limit · resets 2:30am (UTC)",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-29T02:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  // LUN-7056: the ACP engine stamps every failed turn with its own phase code, so a provider
  // session limit reached the recovery pass as `acpx_turn_failed` and fell through to the
  // stranded/`blocked` path. Measured 2026-09-04: 25 runs, 11 issues, 9 wrongly blocked.
  it("classifies a session limit reported through the acpx engine as provider quota", () => {
    const now = new Date("2026-09-04T17:40:01.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "Internal error: You've hit your session limit · resets 8am (Asia/Bangkok)",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      // 08:00 Bangkok (UTC+7) on 2026-09-05 == 01:00Z.
      retryAt: new Date("2026-09-05T01:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "acpx_runtime_error",
    "acpx_timeout",
    "acpx_session_init_failed",
    "acpx_backend_unavailable",
  ])("classifies quota exhaustion surfaced under engine code %s", (errorCode) => {
    const now = new Date("2026-09-04T17:40:01.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode,
      error: "You've hit your session limit · resets 8am (Asia/Bangkok)",
      resultJson: null,
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-09-05T01:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("still ignores non-quota engine failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "Internal error: the agent returned a malformed tool call.",
      resultJson: null,
    })).toBeNull();
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
});

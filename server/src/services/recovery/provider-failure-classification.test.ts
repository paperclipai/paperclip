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

  // The ACP engine reports the phase that noticed the failure, so a subscription
  // running out mid-turn reaches recovery as `acpx_turn_failed`. Without this the
  // run is retried on every heartbeat until the plan resets.
  it("classifies a Claude weekly limit reported through the ACP turn phase", () => {
    const now = new Date("2026-07-31T09:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "You've hit your weekly limit · resets Aug 1 at 10am (Europe/Moscow)",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-01T07:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  // Reverse control for the case above: an ordinary turn failure keeps its
  // previous classification and is not deferred to a made-up reset time.
  it("leaves an ordinary ACP turn failure unclassified", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "Tool 'Bash' failed: exit code 1",
      resultJson: null,
    }, new Date("2026-07-31T09:00:00.000Z"))).toBeNull();
  });

  // An ACP failure is eligible for the quota branch only; misconfiguration
  // reported through a phase code keeps whatever handling it had before.
  it("does not route an ACP failure into the configuration branch", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_session_init_failed",
      error: "No API credentials were found for this provider",
      resultJson: null,
    })).toBeNull();
  });

  it("prefers the reset persisted by the adapter over the message text", () => {
    const now = new Date("2026-07-31T09:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "You've hit your weekly limit · resets Aug 1 at 10am (Europe/Moscow)",
      resultJson: { providerQuotaRetryNotBefore: "2026-08-01T09:00:00.000Z" },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-01T09:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });
});

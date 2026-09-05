import { describe, expect, it } from "vitest";
import {
  FLEET_PAUSE_RECOVERY_BACKOFF_MS,
  INFRA_TRANSIENT_RECOVERY_BACKOFF_MS,
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
  classifyRunFailureClass,
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

  // LUN-7056 review: `configure_session` fails while applying the run's model / effort overrides,
  // so this one engine code can also mean a durable, human-actionable misconfiguration. Quota-shaped
  // text under it must still defer, but a real config blocker under it must still surface as one
  // instead of falling through unclassified.
  it("defers quota exhaustion surfaced under the session-config engine code", () => {
    const now = new Date("2026-09-04T17:40:01.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_session_config_failed",
      error: "You've hit your session limit · resets 8am (Asia/Bangkok)",
      resultJson: null,
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-09-05T01:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("still diagnoses a real configuration blocker reported under the session-config engine code", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_session_config_failed",
      error: "model_not_found: the configured model override does not exist",
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it.each([
    "acpx_turn_failed",
    "acpx_runtime_error",
    "acpx_session_init_failed",
  ])("does not read a generic engine crash under %s as a configuration blocker", (errorCode) => {
    // Not a configuration blocker: the engine crashed, which is infrastructure, so it defers.
    expect(classifyAdapterFailureForRecovery({
      errorCode,
      error: "model_not_found: the agent crashed mid-turn",
      resultJson: null,
    })).toMatchObject({ kind: "infra_transient", errorCode });
  });

  // LUN-7056 AC1: the infrastructure causes that are not quota. Each one means the run could not
  // execute, so none of them may end in `blocked`.
  it.each([
    ["process_lost", INFRA_TRANSIENT_RECOVERY_BACKOFF_MS],
    ["acpx_timeout", INFRA_TRANSIENT_RECOVERY_BACKOFF_MS],
    ["acpx_backend_unavailable", INFRA_TRANSIENT_RECOVERY_BACKOFF_MS],
    ["codex_harness_crash", INFRA_TRANSIENT_RECOVERY_BACKOFF_MS],
    ["issue_paused", FLEET_PAUSE_RECOVERY_BACKOFF_MS],
  ])("classifies %s as a deferrable infrastructure failure", (errorCode, backoffMs) => {
    const now = new Date("2026-09-04T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode,
      error: "the adapter process exited before the turn completed",
      resultJson: null,
    }, now)).toEqual({
      kind: "infra_transient",
      retryAt: new Date(now.getTime() + backoffMs),
      parsedResetTime: false,
      errorCode,
    });
  });

  it("still prefers the quota classification when an infra code carries quota text", () => {
    const now = new Date("2026-09-04T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_timeout",
      error: "You've hit your session limit.",
      resultJson: null,
    }, now)).toMatchObject({ kind: "provider_quota" });
  });

  it("keeps a session-config failure escalating so a real misconfiguration stays visible", () => {
    // `acpx_session_config_failed` is deliberately absent from the infra set: a rejected model id is
    // durable and needs a human, so it must not defer forever on a retry monitor.
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_session_config_failed",
      error: "the runtime rejected the requested model override",
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

// LUN-7056 AC1: the named split. Only a `business` failure may ever end in `blocked`.
describe("classifyRunFailureClass", () => {
  it.each([
    ["process_lost", "the adapter process died"],
    ["acpx_timeout", "the adapter stopped responding"],
    ["issue_paused", "suppressed by an active subtree pause hold"],
    ["adapter_failed", "You've hit your usage limit."],
  ])("classes %s as infra", (errorCode, error) => {
    expect(classifyRunFailureClass({ errorCode, error, resultJson: null })).toBe("infra");
  });

  it.each([
    ["adapter_failed", "model_not_found: requested model does not exist"],
    ["acpx_session_config_failed", "the runtime rejected the requested model override"],
    ["issue_dependencies_blocked", "waiting on an unresolved dependency"],
  ])("classes %s as business", (errorCode, error) => {
    expect(classifyRunFailureClass({ errorCode, error, resultJson: null })).toBe("business");
  });

  it("classes a missing run as business rather than guessing infra", () => {
    expect(classifyRunFailureClass(null)).toBe("business");
  });
});

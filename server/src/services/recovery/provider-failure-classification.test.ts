import { classifyRunLiveness } from "../run-liveness.js";
import { isAiAuthenticationBlocked } from "../ai-auth-failure.js";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
  classifyContinuationFailure,
} from "./service.js";
import { legacyExecutionNeedsReconciliation } from "../legacy-execution-recovery.js";
import { isConfigurationIncompleteFailedRun } from "../../modules/wake-queue/domain/values.js";

describe("classifyAdapterFailureForRecovery", () => {
  it("waits for model configuration changes instead of retrying a typed native model rejection", () => {
    const run = { errorCode: "native_provider_model_rejected", error: "Fixed model configuration message", resultJson: null };
    expect(classifyAdapterFailureForRecovery(run)).toEqual({ kind: "configuration_incomplete" });
    expect(classifyContinuationFailure(run as never)).toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
    expect(isConfigurationIncompleteFailedRun(run)).toBe(true);
    expect(isAiAuthenticationBlocked(run as never)).toBe(false);
    const unknown = { ...run, errorCode: "adapter_failed", error: "native_provider_model_rejected" };
    expect(classifyAdapterFailureForRecovery(unknown)).toBeNull();
    expect(classifyContinuationFailure(unknown as never).kind).toBe("transient_infra");
    expect(isConfigurationIncompleteFailedRun(unknown)).toBe(false);
  });
  it.each(["acpx_auth_required", "claude_auth_required", "codex_auth_required", "adapter_auth_missing", "refresh_token_reused", "authentication_required"])("does not automatically retry provider authentication failure %s", (errorCode) => {
    const classification = classifyRunLiveness({ runStatus: "failed", issue: null, errorCode, authenticationRepairRequested: true });
    const run = { errorCode, ...classification };
    expect(isAiAuthenticationBlocked(run)).toBe(true);
    expect(classifyContinuationFailure(run as never)).toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
  });

  it.each(["kimi_auth_required", "acpx_auth_required", "gemini_auth_required"])("preserves recovery when %s did not produce an inline repair card", (errorCode) => {
    const classification = classifyRunLiveness({ runStatus: "failed", issue: null, errorCode, authenticationRepairRequested: false });
    const run = { errorCode, ...classification };
    expect(isAiAuthenticationBlocked(run)).toBe(false);
    expect(classifyContinuationFailure(run as never).kind).toBe("default");
  });

  it("uses a typed ACP quota reset without needing the provider's original message", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "ACP agent reported a terminal limit failure.",
      resultJson: {
        errorFamily: "provider_quota",
        retryNotBefore: "2026-07-15T21:30:00.000Z",
        providerQuotaRetryNotBefore: "2026-07-15T21:30:00.000Z",
      },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the existing backoff for a typed ACP quota failure with no reset timestamp", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "ACP agent reported a terminal limit failure.",
      resultJson: { errorFamily: "provider_quota" },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

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

  it.each([
    "Claude run failed: subtype=success: You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit resets Oct 7, 5am (America/Toronto)",
    "Claude run failed: subtype=success: You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 4pm (America/Chicago)",
  ])("uses the default quota backoff when the adapter reports no reset time of its own: %s", (error) => {
    const now = new Date("2026-10-04T12:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error,
      resultJson: { errorFamily: "provider_quota", providerQuotaResetUnknown: true },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("ignores a reset in stored stdout when the adapter reports no reset time of its own", () => {
    const now = new Date("2026-10-04T12:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "Claude exited with code 1",
      resultJson: {
        stdout: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 4pm (America/Chicago)\n",
        stderr: "",
        errorFamily: "provider_quota",
        providerQuotaResetUnknown: true,
      },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("ignores a reset in an ACP failure's provider text when the adapter reports no reset time of its own", () => {
    const now = new Date("2026-10-04T12:00:00.000Z");
    const title = "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 4pm (America/Chicago)";
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: `ACP agent reported a terminal limit failure.\n${title}`,
      resultJson: {
        status: "failed",
        terminalSessionFailure: { category: "limit", title },
        errorFamily: "provider_quota",
        providerQuotaResetUnknown: true,
      },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("keeps another adapter's reset when its stored output only quotes a spend limit", () => {
    const now = new Date("2026-10-04T12:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "usage limit reached, try again at 4pm (America/Chicago)",
      resultJson: {
        errorFamily: "provider_quota",
        stdout: "Earlier output: \"You've hit your monthly spend limit\"\n",
      },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-10-04T21:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("keeps a weekly limit's reset when only the run summary quotes a spend limit", () => {
    const now = new Date("2026-10-04T12:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "Claude run failed: subtype=success: You've hit your weekly limit · resets 5pm (America/Chicago)",
      resultJson: {
        errorFamily: "provider_quota",
        summary: "The user saw \"You've hit your monthly spend limit\" yesterday.",
      },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-10-04T22:00:00.000Z"),
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

  it("routes unavailable engines to a configuration blocker instead of retrying", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_engine_unavailable",
      error: "Node v22.22.2 does not satisfy Codex ACP's Node >=24.11.0 prerequisite.",
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
    expect(classifyContinuationFailure({ errorCode: "adapter_engine_unavailable" } as never))
      .toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy",
      status: "failed",
      errorCode: "adapter_engine_unavailable",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    })).toBe(false);
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });
  it("holds invalid provider definitions for repair even with stale transient metadata", () => {
    const run = { errorCode: "provider_tool_definition_invalid", error: "Tool name is too long.",
      resultJson: { errorFamily: "transient_upstream" } };
    expect(classifyAdapterFailureForRecovery(run)).toEqual({ kind: "configuration_incomplete" });
    expect(classifyContinuationFailure(run as never)).toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
  });
});

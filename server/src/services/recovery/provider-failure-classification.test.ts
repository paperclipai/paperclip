import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
} from "./service.js";

describe("classifyAdapterFailureForRecovery", () => {
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
});

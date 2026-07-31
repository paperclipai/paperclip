import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_FAILURE_RECOVERY_ERROR_CODES,
  INTENTIONALLY_UNCLASSIFIED_ADAPTER_FAILURE_ERROR_CODES,
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

  it("classifies Claude weekly limits and parses date-bearing reset times", () => {
    const now = new Date("2026-07-29T19:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your weekly limit · resets Aug 3 at 11am (Europe/Zurich)",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-03T09:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("classifies Claude spend caps as provider quota without a reset time", () => {
    const now = new Date("2026-07-30T00:10:38.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
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

  it("classifies the emitted quota and transient retry families", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
      resultJson: null,
    })?.kind).toBe("provider_quota");

    for (const errorCode of [
      "acpx_turn_failed",
      "acpx_session_init_failed",
      "acpx_stream_idle_timeout",
      "paperclip_control_plane_unreachable",
      "process_lost",
    ]) {
      expect(classifyAdapterFailureForRecovery({
        errorCode,
        error: "synthetic emitted transient failure",
        resultJson: null,
      })).toEqual({ kind: "transient_infra" });
    }
  });

  it("source-derives emitted failure codes and requires classification or explicit exclusion", () => {
    const acpxSource = fs.readFileSync(
      new URL("../../../../packages/adapter-utils/src/acpx-engine/execute.ts", import.meta.url),
      "utf8",
    );
    const processSource = fs.readFileSync(new URL("../../adapters/process/execute.ts", import.meta.url), "utf8");
    const heartbeatSource = fs.readFileSync(new URL("../heartbeat.ts", import.meta.url), "utf8");

    const derivedCodes = new Set<string>();
    for (const match of acpxSource.matchAll(/return "(acpx_[a-z_]+)"|errorCode:\s*"(acpx_[a-z_]+)"/g)) {
      derivedCodes.add(match[1] ?? match[2] ?? "");
    }
    for (const match of processSource.matchAll(/errorCode:\s*"([a-z_]+)"/g)) {
      derivedCodes.add(match[1] ?? "");
    }
    for (const match of heartbeatSource.matchAll(
      /CONFIGURATION_INCOMPLETE_FAILURE_CODE = "([a-z_]+)"|if \(run\.errorCode === "(provider_quota)"\)|errorCode:\s*"(process_lost)"|\?\? "(adapter_failed)"/g,
    )) {
      derivedCodes.add(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
    }
    derivedCodes.delete("");

    expect(derivedCodes.size).toBeGreaterThan(0);
    for (const errorCode of derivedCodes) {
      expect(
        ADAPTER_FAILURE_RECOVERY_ERROR_CODES.has(errorCode) ||
          INTENTIONALLY_UNCLASSIFIED_ADAPTER_FAILURE_ERROR_CODES.has(errorCode),
        `${errorCode} must be classified or intentionally excluded`,
      ).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { mapClaudeAcpLimitErrorCode } from "./acp.js";

function turnFailure(overrides: Partial<AdapterExecutionResult> = {}): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "acpx_turn_failed",
    errorMessage: null,
    resultJson: { phase: "turn" },
    ...overrides,
  };
}

describe("mapClaudeAcpLimitErrorCode", () => {
  it("classifies a session-limit turn failure as provider_quota with the parsed reset time", () => {
    const now = new Date("2026-09-10T03:18:53.000Z"); // 10:18 in Asia/Bangkok (UTC+7)
    const result = mapClaudeAcpLimitErrorCode(
      turnFailure({
        errorMessage: "Internal error: You've hit your session limit · resets 1:30pm (Asia/Bangkok)",
      }),
      now,
    );
    expect(result.errorCode).toBe("provider_quota");
    expect(result.errorFamily).toBe("provider_quota");
    // 1:30pm Asia/Bangkok = 06:30 UTC, same day (still ahead of `now`).
    expect(result.retryNotBefore).toBe("2026-09-10T06:30:00.000Z");
    expect(result.resultJson).toMatchObject({
      phase: "turn",
      errorFamily: "provider_quota",
      retryNotBefore: "2026-09-10T06:30:00.000Z",
      transientRetryNotBefore: "2026-09-10T06:30:00.000Z",
      providerQuotaRetryNotBefore: "2026-09-10T06:30:00.000Z",
    });
  });

  it("classifies a weekly-limit turn failure as provider_quota", () => {
    const result = mapClaudeAcpLimitErrorCode(
      turnFailure({
        errorMessage: "Internal error: You've hit your weekly limit · resets 4pm (America/Chicago)",
      }),
      new Date("2026-09-10T03:00:00.000Z"),
    );
    expect(result.errorCode).toBe("provider_quota");
    expect(result.retryNotBefore).toBe("2026-09-10T21:00:00.000Z"); // 4pm CDT = 21:00 UTC
  });

  it("keeps the quota classification when the message states no reset time", () => {
    const result = mapClaudeAcpLimitErrorCode(
      turnFailure({ errorMessage: "Claude usage limit reached." }),
    );
    expect(result.errorCode).toBe("provider_quota");
    expect(result.retryNotBefore).toBeUndefined();
    expect(result.resultJson).toMatchObject({ errorFamily: "provider_quota" });
  });

  it("leaves non-limit turn failures untouched", () => {
    const input = turnFailure({ errorMessage: "Internal error: something else entirely" });
    expect(mapClaudeAcpLimitErrorCode(input)).toBe(input);
  });

  it("leaves other error codes untouched even when the message mentions a limit", () => {
    const input = turnFailure({
      errorCode: "acpx_runtime_error",
      errorMessage: "You've hit your session limit · resets 2pm (Asia/Bangkok)",
    });
    expect(mapClaudeAcpLimitErrorCode(input)).toBe(input);
  });

  it("never classifies from transcript noise: only the error surface is read", () => {
    const input = turnFailure({
      errorMessage: "Internal error: unrelated failure",
      resultJson: {
        phase: "turn",
        stdout: "the agent transcript casually mentions: you've hit your session limit · resets 9am",
      },
    });
    expect(mapClaudeAcpLimitErrorCode(input)).toBe(input);
  });
});

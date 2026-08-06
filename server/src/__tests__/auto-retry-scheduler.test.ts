import { describe, expect, it } from "vitest";
import { evaluateAutoRetryEligibility } from "../services/auto-retry-scheduler.js";

function fakeRun(overrides: Partial<{
  autoRetryCount: number;
  error: string | null;
  errorCode: string | null;
  stdoutExcerpt: string | null;
  resultJson: unknown;
  status: string;
}> = {}) {
  return {
    autoRetryCount: overrides.autoRetryCount ?? 0,
    error: overrides.error ?? null,
    errorCode: overrides.errorCode ?? null,
    stdoutExcerpt: overrides.stdoutExcerpt ?? null,
    resultJson: overrides.resultJson ?? null,
    status: overrides.status ?? "failed",
  } as any;
}

describe("auto-retry-scheduler eligibility", () => {
  it("ignores runs with stdout output", () => {
    const r = evaluateAutoRetryEligibility(
      fakeRun({
        error: "Process lost -- server may have restarted",
        errorCode: "process_lost",
        stdoutExcerpt: "downloaded something",
        status: "failed",
      }),
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("has_output");
  });

  it("ignores non-transient failures", () => {
    const r = evaluateAutoRetryEligibility(
      fakeRun({
        error: "adapter x failed",
        errorCode: "adapter_failed",
        stdoutExcerpt: null,
        status: "failed",
      }),
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("not_transient");
  });

  it("honors maxRetries cap", () => {
    const r = evaluateAutoRetryEligibility(
      fakeRun({
        error: "Process lost -- server may have restarted",
        stdoutExcerpt: null,
        status: "failed",
        autoRetryCount: 3,
      }),
      new Date(),
      3,
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("max_retries_reached");
  });

  it("schedules an exponential backoff retry for an empty-stdout failure", () => {
    const now = new Date("2026-08-06T00:00:00.000Z");
    const r = evaluateAutoRetryEligibility(
      fakeRun({
        error: "Process lost -- server may have restarted",
        errorCode: "process_lost",
        stdoutExcerpt: null,
        status: "failed",
      }),
      now,
      3,
    );
    expect(r.eligible).toBe(true);
    expect(r.retryAttempt).toBe(1);
    expect(r.reason).toBe("process_lost");
    expect(r.nextRetryAt?.getTime()).toBe(now.getTime() + 1_000);
  });

  it("recognises gateway_closed 1012 errors as transient", () => {
    const r = evaluateAutoRetryEligibility(
      fakeRun({
        error: "socket: connection lost; gateway closed (1012): service restart",
        stdoutExcerpt: null,
        status: "failed",
      }),
    );
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("gateway_closed");
  });

  it("recognises adapter_missing as transient (no observable work)", () => {
    const r = evaluateAutoRetryEligibility(
      fakeRun({
        error: "ENOENT: spawn agent ENOENT - no command in PATH",
        errorCode: "adapter_missing",
        stdoutExcerpt: null,
        status: "failed",
      }),
    );
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("adapter_missing");
  });
});

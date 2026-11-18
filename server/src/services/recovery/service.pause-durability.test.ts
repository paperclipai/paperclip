import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./service.js";

const run = (errorCode: string | null) =>
  ({ errorCode } as unknown as Parameters<typeof classifyContinuationFailure>[0]);

describe("pause durability: continuation retry classification", () => {
  it("agent_paused is retryable so work resumes (Option A: Resume Continues Work)", () => {
    // Pause still emits errorCode agent_paused for observability, but it is NOT
    // non-retryable. On resume the agent becomes invokable again and this classifies
    // as default/retryable, so the continuation re-enqueues and the issue continues
    // rather than escalating to blocked. Durability is guaranteed separately by the
    // execution-start guard (Change B), not by this classification.
    const c = classifyContinuationFailure(run("agent_paused"));
    expect(c.kind).toBe("default");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  it("agent_not_invokable (execution-start abort) is non-retryable", () => {
    expect(classifyContinuationFailure(run("agent_not_invokable")).kind).toBe("non_retryable");
  });

  it("timed_out (timeout) still retries as transient infra", () => {
    const c = classifyContinuationFailure(run("timeout"));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  it("generic cancelled (non-pause cancellation) is NOT non-retryable", () => {
    // non-pause cancellations (the internal invokability cancel and budget pause) keep errorCode "cancelled" -> default branch
    expect(classifyContinuationFailure(run("cancelled")).kind).toBe("default");
  });

  it("genuine failure with no/unknown code retries via default branch", () => {
    expect(classifyContinuationFailure(run(null)).kind).toBe("default");
    expect(classifyContinuationFailure(run("some_adapter_error")).kind).toBe("default");
  });

  it("transient DB-driver failures (AGE-815) retry as transient infra", () => {
    // Before AGE-815 these were recorded as adapter_failed and caught by the
    // transient-infra set; now they carry dedicated pg_<sqlstate> / db_query_failed
    // codes and must still be classified transient so continuation recovery reschedules.
    for (const code of ["pg_57P01", "pg_08006", "db_query_failed"]) {
      const c = classifyContinuationFailure(run(code));
      expect(c.kind).toBe("transient_infra");
      expect(c.maxAttempts).toBeGreaterThan(0);
    }
  });

  it("deterministic DB failures (AGE-815) fail fast via the default branch", () => {
    // Constraint / missing-object errors are deterministic bugs, not infra blips,
    // so they must NOT be retried as transient infra.
    for (const code of ["pg_23505", "pg_42P01"]) {
      expect(classifyContinuationFailure(run(code)).kind).toBe("default");
    }
  });
});

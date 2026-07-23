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

  it("workspace_validation_failed is non-retryable so recovery stops re-dispatching a doomed wake (LOOA-700)", () => {
    // A workspace-validation failure happens before the adapter launches: the persisted
    // execution-workspace link / project workspace cwd / git checkout is structurally
    // wrong, so every requeued continuation dies identically. Classifying it as
    // non_retryable makes the stranded-issue recovery escalate to blocked once instead
    // of tight-looping a ~30s requeue storm that never self-heals.
    const c = classifyContinuationFailure(run("workspace_validation_failed"));
    expect(c.kind).toBe("non_retryable");
    expect(c.maxAttempts).toBe(0);
  });
});

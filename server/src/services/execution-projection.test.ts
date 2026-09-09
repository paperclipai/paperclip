import { describe, expect, it } from "vitest";
import { projectExecution } from "./execution-projection.js";

type Run = Parameters<typeof projectExecution>[0];
type Coordinator = NonNullable<Parameters<typeof projectExecution>[1]>;
const now = new Date("2026-09-08T12:00:00Z");
const run = (values: Partial<Run> = {}) =>
  ({
    status: "running",
    runtimeMode: "native",
    errorCode: null,
    nextAction: null,
    lastUsefulActionAt: now,
    lastOutputAt: null,
    startedAt: now,
    scheduledRetryAt: null,
    scheduledRetryAttempt: 1,
    retryOfRunId: null,
    executionControlDeadlineAt: null,
    ...values,
  }) as Run;
const coordinator = (values: Partial<Coordinator> = {}) =>
  ({
    phase: "observed",
    attempt: 1,
    failureCode: null,
    failureDetail: {},
    nextAttemptAt: null,
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    controlDeadlineAt: null,
    ...values,
  }) as Coordinator;
const project = (
  r = run(),
  c: Coordinator | undefined = coordinator(),
  pending: { kind: string }[] = [],
) => projectExecution(r, c, pending, undefined, now);

describe("execution truth projection", () => {
  it("shows a workspace wait without presenting its deferral count as failed attempts", () => {
    expect(projectExecution(run({ runtimeMode: "legacy", status: "scheduled_retry", scheduledRetryReason: "workspace_busy",
      scheduledRetryAttempt: 12, contextSnapshot: { failureRetriesBeforeWorkspaceWait: 1 } }), undefined, [], undefined, now))
      .toMatchObject({ label: "Waiting for workspace", phase: "retry_scheduled", attempt: 2, recoveryOwner: null });
  });
  it("shows a reconciled continuation as queued until its durable delivery is recorded", () => {
    const action = {
      cause: "native_session_retry_exhausted",
      nextAction: "Old recovery action",
      status: "resolved" as const,
      evidence: {
        executionReconciliation: { runId: "old" },
        continuationDelivery: "pending",
      },
    };
    expect(
      projectExecution(
        run({ status: "failed" }),
        coordinator({ phase: "terminal_failure" }),
        [],
        action,
        now,
      ),
    ).toMatchObject({
      phase: "queued",
      label: "Continuation queued",
      cause: null,
    });
    expect(
      projectExecution(
        run({ status: "failed" }),
        coordinator({ phase: "terminal_failure" }),
        [],
        {
          ...action,
          evidence: { ...action.evidence, continuationRunId: "next" },
        },
        now,
      ),
    ).toMatchObject({ phase: "completed", successorRunId: "next" });
    expect(
      projectExecution(
        run({ status: "failed" }),
        coordinator({ phase: "terminal_failure" }),
        [],
        {
          ...action,
          evidence: { ...action.evidence, continuationDelivery: "invalidated" },
        },
        now,
      ),
    ).toMatchObject({ phase: "failed", label: "Continuation cancelled" });
  });
  it("requires current execution evidence, without treating output silence as failure", () => {
    expect(project(run({ lastOutputAt: new Date(0) })).phase).toBe("working");
    expect(
      project(run(), coordinator({ leaseExpiresAt: new Date(0) })),
    ).toMatchObject({ phase: "reconnecting", label: "Confirming execution" });
    expect(
      project(
        run({ runtimeMode: "legacy", processPid: process.pid }),
        undefined,
      ).phase,
    ).toBe("working");
  });
  it("distinguishes provider work, finalization and timed retry", () => {
    expect(
      project(
        run({ executionControlDeadlineAt: new Date(now.getTime() + 60_000) }),
      ).phase,
    ).toBe("finishing");
    expect(
      project(
        run({ status: "failed" }),
        coordinator({
          phase: "retryable_failure",
          nextAttemptAt: new Date(now.getTime() + 30_000),
          attempt: 2,
        }),
      ),
    ).toMatchObject({ phase: "retry_scheduled", attempt: 2, maxAttempts: 3 });
    expect(
      project(
        run({ status: "failed" }),
        coordinator({ phase: "retryable_failure", nextAttemptAt: new Date(0) }),
      ).phase,
    ).toBe("reconnecting");
  });
  it("includes the original legacy attempt in the displayed incident budget", () => {
    expect(projectExecution(run({ runtimeMode: "legacy", status: "scheduled_retry", scheduledRetryAttempt: 1 }), undefined, [], undefined, now)).toMatchObject({ attempt: 2, maxAttempts: 3 });
  });
  it("shows pending interaction only after productive work has stopped", () => {
    expect(
      project(run(), coordinator(), [{ kind: "connection_intent" }]).phase,
    ).toBe("working");
    expect(
      project(run({ status: "succeeded" }), undefined, [
        { kind: "connection_intent" },
      ]).phase,
    ).toBe("waiting_for_access");
    expect(
      project(run({ status: "succeeded" }), undefined, [
        { kind: "ask_user_questions" },
      ]).phase,
    ).toBe("waiting_for_answer");
  });
  it("retains replacement lineage and exposes operator-owned failures for legacy runs", () => {
    expect(
      project(
        run({ status: "failed" }),
        coordinator({
          phase: "terminal_failure",
          failureDetail: { successorRunId: "replacement" },
        }),
      ),
    ).toMatchObject({ phase: "completed", successorRunId: "replacement" });
    expect(
      projectExecution(
        run({ runtimeMode: "legacy", status: "failed" }),
        undefined,
        [],
        {
          cause: "uncertain_external_action",
          nextAction: "Reconcile the email delivery.",
        },
        now,
      ),
    ).toMatchObject({
      phase: "recovery_needed",
      recoveryOwner: "board",
      nextAction: "Reconcile the email delivery.",
    });
  });
  it("bounds recovery checking and surfaces its next action if verification never finishes", () => {
    const c = coordinator({
      phase: "terminal_failure",
      failureCode: "native_provider_terminal_failed",
    });
    expect(project(run({ status: "failed", finishedAt: now }), c).label).toBe(
      "Checking recovery",
    );
    expect(
      project(
        run({ status: "failed", finishedAt: new Date(now.getTime() - 60_000) }),
        c,
      ).phase,
    ).toBe("recovery_needed");
    expect(
      project(
        run({ status: "failed", finishedAt: now }),
        coordinator({
          ...c,
          failureDetail: { replacementDenied: "uncertain_provider_action" },
        }),
      ).phase,
    ).toBe("recovery_needed");
  });
});

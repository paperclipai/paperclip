import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RUNNER_TIMEOUT_CONTINUATIONS,
  buildRunnerTimeoutContinuationIdempotencyKey,
  buildRunnerTimeoutContinuationInstruction,
  decideRunnerTimeoutContinuation,
  readPersistedRunnerTimeout,
} from "./runner-timeout-continuation.js";

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-source",
    companyId: "company-1",
    agentId: "agent-1",
    status: "timed_out",
    errorCode: "timeout",
    resultJson: null,
    ...overrides,
  } as never;
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    executionState: null,
    projectId: "project-1",
    ...overrides,
  } as never;
}

function agent(overrides: Record<string, unknown> = {}) {
  return { id: "agent-1", companyId: "company-1", status: "idle", ...overrides } as never;
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "paperclip-issue-lane",
    modelStarted: true,
    resumable: true,
    progress: { requests: 7, denials: 0, lastRequestAt: "2026-09-10T00:00:00.000Z" },
    ...overrides,
  } as never;
}

function decide(overrides: Record<string, unknown> = {}) {
  return decideRunnerTimeoutContinuation({
    run: run(),
    issue: issue(),
    agent: agent(),
    evidence: evidence(),
    continuationAttempt: 0,
    budgetBlocked: false,
    idempotentWakeExists: false,
    ...overrides,
  } as never);
}

describe("readPersistedRunnerTimeout", () => {
  it("reads the adapter's evidence only from a timed-out run", () => {
    const resultJson = {
      runnerTimeout: {
        sessionId: "paperclip-issue-lane",
        modelStarted: true,
        resumable: true,
        progress: { requests: 3, denials: 0, lastRequestAt: null },
      },
    };
    expect(readPersistedRunnerTimeout({ status: "timed_out", resultJson })).toMatchObject({
      sessionId: "paperclip-issue-lane",
      resumable: true,
    });
    expect(readPersistedRunnerTimeout({ status: "failed", resultJson })).toBeNull();
    expect(readPersistedRunnerTimeout({ status: "timed_out", resultJson: {} })).toBeNull();
    expect(
      readPersistedRunnerTimeout({
        status: "timed_out",
        resultJson: { runnerTimeout: { modelStarted: false, resumable: true } },
      }),
    ).toBeNull();
  });
});

describe("decideRunnerTimeoutContinuation", () => {
  it("resumes the same session with a bounded attempt and a receipts-aware instruction", () => {
    const decision = decide();
    expect(decision).toMatchObject({
      kind: "enqueue",
      nextAttempt: 1,
      maxAttempts: DEFAULT_MAX_RUNNER_TIMEOUT_CONTINUATIONS,
      resumeSessionId: "paperclip-issue-lane",
    });
    if (decision.kind !== "enqueue") throw new Error("expected an enqueue decision");
    expect(decision.idempotencyKey).toBe(
      buildRunnerTimeoutContinuationIdempotencyKey({
        issueId: "issue-1",
        sourceRunId: "run-source",
        nextAttempt: 1,
      }),
    );
    expect(decision.instruction).toContain("run-source");
    expect(decision.instruction).toContain("paperclip-issue-lane");
    expect(decision.instruction).toContain("Do not repeat external actions");
    expect(decision.extraContext).toMatchObject({
      runnerTimeoutContinuation: true,
      resumeFromCheckpoint: true,
      runnerTimeoutContinuationAttempt: 1,
    });
  });

  it("stops at the attempt bound instead of restarting forever", () => {
    const decision = decide({
      continuationAttempt: DEFAULT_MAX_RUNNER_TIMEOUT_CONTINUATIONS,
    });
    expect(decision.kind).toBe("exhausted");
    if (decision.kind !== "exhausted") throw new Error("expected an exhausted decision");
    expect(decision.comment).toContain("not raised automatically");
  });

  it("requires real progress before resuming a session", () => {
    expect(decide({ evidence: evidence({ progress: { requests: 0, denials: 0, lastRequestAt: null } }) })).toMatchObject({
      kind: "skip",
    });
    expect(decide({ evidence: evidence({ progress: null }) })).toMatchObject({ kind: "skip" });
    expect(decide({ evidence: evidence({ resumable: false }) })).toMatchObject({ kind: "skip" });
    expect(decide({ evidence: null })).toMatchObject({ kind: "skip" });
  });

  it("keeps every existing gate ahead of the continuation", () => {
    expect(decide({ run: run({ status: "failed" }) })).toMatchObject({ kind: "skip" });
    expect(decide({ run: run({ errorCode: "adapter_failed" }) })).toMatchObject({ kind: "skip" });
    expect(decide({ issue: issue({ status: "in_review" }) })).toMatchObject({ kind: "skip" });
    expect(decide({ issue: issue({ executionState: { status: "pending" } }) })).toMatchObject({ kind: "skip" });
    expect(decide({ issue: issue({ assigneeAgentId: "agent-2" }) })).toMatchObject({ kind: "skip" });
    expect(decide({ agent: agent({ status: "paused" }) })).toMatchObject({ kind: "skip" });
    expect(decide({ issue: null })).toMatchObject({ kind: "skip" });
    expect(decide({ budgetBlocked: true })).toMatchObject({ kind: "skip" });
  });

  it("reports a duplicate rather than a skippable state when the attempt already has a live wake", () => {
    const duplicate = decide({ idempotentWakeExists: true });
    expect(duplicate).toMatchObject({ kind: "duplicate", attempt: 0, nextAttempt: 1 });
    if (duplicate.kind !== "duplicate") throw new Error("expected a duplicate decision");
    // The caller needs the key to know WHICH attempt is already live; a caller
    // that fell through to another wake would duplicate it and reset the bound.
    expect(duplicate.idempotencyKey).toBe(
      buildRunnerTimeoutContinuationIdempotencyKey({
        issueId: "issue-1",
        sourceRunId: "run-source",
        nextAttempt: 1,
      }),
    );
  });

  it("builds one stable instruction for a run without a recorded session", () => {
    const instruction = buildRunnerTimeoutContinuationInstruction({
      sourceRunId: "run-source",
      sessionId: null,
      requests: 2,
    });
    expect(instruction).toContain("Resume from your last checkpoint");
    expect(instruction).not.toContain("null");
  });
});

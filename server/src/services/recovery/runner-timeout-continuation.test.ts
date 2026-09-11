import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RUNNER_TIMEOUT_CONTINUATIONS,
  buildRunnerTimeoutContinuationIdempotencyKey,
  decideRunnerTimeoutContinuation,
  readPersistedRunnerTimeout,
} from "./runner-timeout-continuation.js";
import { RUNNER_TIMEOUT_EXIT_CODE, readRunnerTimeoutEvidence } from "../execution-resource-admission.js";

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


  it("continues a launcher-issued timeout from the evidence the adapter persisted", () => {
    // The launcher times the run out itself (its wall clock is shorter than
    // native's) and reports the outcome as the run_timeout envelope; the
    // adapter reads it in the non-zero branch and persists it as runnerTimeout.
    const sourceRunId = "6dacba3a-5268-420f-b2fd-d0bb4dea3a02";
    const stdout = [
      '{"type":"thinking_delta","text":"mid-turn work"}',
      JSON.stringify({
        schemaVersion: 1,
        kind: "run_timeout",
        status: "timed_out",
        runId: sourceRunId,
        issueId: "fc51e706-0000-4000-8000-000000000003",
        sessionId: "paperclip-fc51e706-3ae84a40a9322b59f153",
        modelStarted: true,
        resumable: true,
        progress: { requests: 99, denials: 1, lastEventAt: "2026-09-11T08:05:06.656Z" },
        exitCode: RUNNER_TIMEOUT_EXIT_CODE,
      }),
    ].join("\n");
    const adapterEvidence = readRunnerTimeoutEvidence({
      exitCode: RUNNER_TIMEOUT_EXIT_CODE,
      stdout,
      runId: sourceRunId,
    });
    expect(adapterEvidence).not.toBeNull();

    const persisted = readPersistedRunnerTimeout({
      status: "timed_out",
      resultJson: { runnerTimeout: adapterEvidence },
    });
    expect(persisted).toMatchObject({
      sessionId: "paperclip-fc51e706-3ae84a40a9322b59f153",
      modelStarted: true,
      resumable: true,
      progress: { requests: 99, denials: 1, lastRequestAt: "2026-09-11T08:05:06.656Z" },
    });

    // The same bounded session-resuming continuation engages: one attempt, the
    // checkpoint session, and the receipts-aware instruction.
    const decision = decide({ run: run({ id: sourceRunId }), evidence: persisted });
    expect(decision).toMatchObject({
      kind: "enqueue",
      nextAttempt: 1,
      maxAttempts: DEFAULT_MAX_RUNNER_TIMEOUT_CONTINUATIONS,
      resumeSessionId: "paperclip-fc51e706-3ae84a40a9322b59f153",
    });
    if (decision.kind !== "enqueue") throw new Error("expected an enqueue decision");
    expect(decision.instruction).toContain("paperclip-fc51e706-3ae84a40a9322b59f153");
    expect(decision.extraContext).toMatchObject({ resumeFromCheckpoint: true });
  });

  it("does not mint a continuation from a bare or unproven launcher timeout", () => {
    // A bare 124 without the envelope is persisted as an ordinary failure row,
    // so the persisted reader sees no evidence and the chain never starts.
    expect(
      readPersistedRunnerTimeout({
        status: "failed",
        resultJson: { stdout: "Process exited with code 124" },
      }),
    ).toBeNull();
    expect(
      readPersistedRunnerTimeout({
        status: "timed_out",
        resultJson: { stdout: "no runnerTimeout key" },
      }),
    ).toBeNull();
  });
});

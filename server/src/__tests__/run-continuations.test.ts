import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
  RUN_LIVENESS_CONTINUATION_REASON,
  buildRunLivenessContinuationIdempotencyKey,
  decideRunLivenessContinuation,
} from "../services/run-continuations.ts";

const companyId = "company-1";
const agentId = "agent-1";
const issueId = "issue-1";
const runId = "run-1";

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    companyId,
    agentId,
    continuationAttempt: 0,
    ...overrides,
  } as never;
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    identifier: "PAP-1577",
    title: "Add bounded liveness continuation wakes",
    status: "in_progress",
    assigneeAgentId: agentId,
    executionState: null,
    projectId: null,
    unblockDescriptor: null,
    ...overrides,
  } as never;
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    companyId,
    status: "idle",
    ...overrides,
  } as never;
}

describe("run liveness continuations", () => {
  it("enqueues the first plan_only continuation for the same issue and assignee", () => {
    const decision = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: "plan_only",
      livenessReason: "Planned without acting",
      nextAction: "Take the first concrete action now.",
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.nextAttempt).toBe(1);
    expect(decision.idempotencyKey).toBe(
      buildRunLivenessContinuationIdempotencyKey({
        issueId,
        sourceRunId: runId,
        livenessState: "plan_only",
        nextAttempt: 1,
      }),
    );
    expect(decision.payload).toMatchObject({
      issueId,
      sourceRunId: runId,
      livenessState: "plan_only",
      livenessReason: "Planned without acting",
      continuationAttempt: 1,
      maxContinuationAttempts: DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
      instruction: "Take the first concrete action now.",
    });
    expect(decision.payload).not.toHaveProperty("modelProfile");
    expect(decision.contextSnapshot).toMatchObject({
      issueId,
      wakeReason: RUN_LIVENESS_CONTINUATION_REASON,
      livenessContinuationAttempt: 1,
      livenessContinuationMaxAttempts: DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
      livenessContinuationSourceRunId: runId,
      livenessContinuationState: "plan_only",
      livenessContinuationReason: "Planned without acting",
      livenessContinuationInstruction: "Take the first concrete action now.",
    });
    expect(decision.contextSnapshot).not.toHaveProperty("modelProfile");
  });

  it("enqueues the second empty_response continuation", () => {
    const decision = decideRunLivenessContinuation({
      run: run({ continuationAttempt: 1 }),
      issue: issue(),
      agent: agent(),
      livenessState: "empty_response",
      livenessReason: "No useful output",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("enqueue");
    if (decision.kind !== "enqueue") return;
    expect(decision.nextAttempt).toBe(2);
  });

  it("leaves advanced terminal runs to stranded issue recovery instead of bounded liveness continuation", () => {
    const decision = decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent: agent(),
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: created an issue comment",
      nextAction: "Resume the implementation from the remaining acceptance criteria.",
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision).toEqual({
      kind: "skip",
      reason: "liveness state is not actionable for continuation",
    });
  });

  it("does not enqueue a third continuation and returns an exhaustion comment", () => {
    const decision = decideRunLivenessContinuation({
      run: run({ continuationAttempt: 2 }),
      issue: issue(),
      agent: agent(),
      livenessState: "plan_only",
      livenessReason: "Still planning",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });

    expect(decision.kind).toBe("exhausted");
    if (decision.kind !== "exhausted") return;
    expect(decision.comment).toContain("Bounded liveness continuation exhausted");
    expect(decision.comment).toContain("Attempts used: 2/2");
  });

  it("uses the durable issue-and-cause attempt when a replacement run lost its local counter", () => {
    const decision = decideRunLivenessContinuation({
      run: run({ continuationAttempt: 0 }),
      issue: issue(),
      agent: agent(),
      livenessState: "plan_only",
      livenessReason: "Replacement run planned without acting",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      durableAttempt: DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
    });

    expect(decision.kind).toBe("exhausted");
    if (decision.kind !== "exhausted") return;
    expect(decision.attempt).toBe(DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS);
  });

  it("finalizes an incomplete blocked issue only after the durable budget is exhausted", () => {
    const exhausted = decideRunLivenessContinuation({
      run: run(),
      issue: issue({ status: "blocked", unblockDescriptor: null }),
      agent: agent(),
      livenessState: "plan_only",
      livenessReason: "Replacement run planned without acting",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      durableAttempt: DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
    });
    const notExhausted = decideRunLivenessContinuation({
      run: run(),
      issue: issue({ status: "blocked", unblockDescriptor: null }),
      agent: agent(),
      livenessState: "plan_only",
      livenessReason: "Replacement run planned without acting",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      durableAttempt: DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS - 1,
    });

    expect(exhausted.kind).toBe("exhausted");
    expect(notExhausted).toEqual({
      kind: "skip",
      reason: "blocked issue may be finalized on exhaustion but not continued",
    });
  });

  it("keeps idempotency stable across replacement source runs for the same issue and cause", () => {
    const first = buildRunLivenessContinuationIdempotencyKey({
      issueId,
      sourceRunId: "replacement-run-1",
      livenessState: "plan_only",
      nextAttempt: 2,
    });
    const second = buildRunLivenessContinuationIdempotencyKey({
      issueId,
      sourceRunId: "replacement-run-2",
      livenessState: "plan_only",
      nextAttempt: 2,
    });

    expect(first).toBe(second);
  });

  it("bounds a high-run replacement storm with one issue-and-cause budget", () => {
    const decisions = Array.from({ length: 100 }, (_, index) =>
      decideRunLivenessContinuation({
        run: run({ id: `replacement-${index}`, continuationAttempt: 0 }),
        issue: issue(),
        agent: agent(),
        livenessState: "plan_only",
        livenessReason: "Replacement run planned without acting",
        nextAction: null,
        budgetBlocked: false,
        idempotentWakeExists: false,
        durableAttempt: DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS,
      }),
    );

    expect(decisions.every((decision) => decision.kind === "exhausted")).toBe(true);
  });

  it("starts a new idempotency epoch after durable implementation progress", () => {
    const beforeProgress = buildRunLivenessContinuationIdempotencyKey({
      issueId,
      sourceRunId: "run-before-progress",
      livenessState: "plan_only",
      nextAttempt: 1,
    });
    const afterProgress = buildRunLivenessContinuationIdempotencyKey({
      issueId,
      sourceRunId: "run-after-progress",
      livenessState: "plan_only",
      nextAttempt: 1,
      budgetEpoch: "2026-04-18T12:00:00.000Z",
    });

    expect(afterProgress).not.toBe(beforeProgress);
  });

  it("skips non-actionable and guarded issues", () => {
    const guardedCases = [
      { livenessState: "advanced" as const },
      { issue: issue({ status: "done" }) },
      { issue: issue({ assigneeAgentId: "other-agent" }) },
      { issue: issue({ executionState: { status: "pending" } }) },
      { agent: agent({ status: "paused" }) },
      { budgetBlocked: true },
      { idempotentWakeExists: true },
    ];

    for (const guarded of guardedCases) {
      const decision = decideRunLivenessContinuation({
        run: run(),
        issue: guarded.issue ?? issue(),
        agent: guarded.agent ?? agent(),
        livenessState: guarded.livenessState ?? "plan_only",
        livenessReason: "No progress",
        nextAction: null,
        budgetBlocked: guarded.budgetBlocked ?? false,
        idempotentWakeExists: guarded.idempotentWakeExists ?? false,
      });

      expect(decision.kind).toBe("skip");
    }
  });
});

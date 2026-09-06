import { describe, expect, it, vi } from "vitest";
import type { QueuedRunFacts, ReviewParticipantFacts, ScheduledRetryFacts } from "../domain/policy.js";
import {
  createCancelDecidedStaleQueuedRun,
  createCancelStaleQueuedRun,
  createPromoteDueScheduledRetries,
  createPromoteScheduledRetry,
} from "./use-cases.js";
import type {
  DueRetryRun,
  LoadGateFactsInput,
  LoadGateFactsResult,
  LoadStalenessFactsInput,
  QueuedRunReader,
  RunDispatchWriter,
  ScheduledRetryReader,
} from "./ports.js";

const NO_REVIEW_PARTICIPANT: ReviewParticipantFacts = {
  isInReview: false,
  hasParticipant: false,
  participantIsAgent: false,
  participantAgentId: null,
  currentStageType: null,
  currentParticipant: null,
};

function scheduledRetryFacts(overrides: Partial<ScheduledRetryFacts> = {}): ScheduledRetryFacts {
  return {
    runId: "run-1",
    runAgentId: "agent-1",
    issueId: null,
    retryReasonKind: "other",
    enforceIssueExecutionLock: false,
    budgetBlock: null,
    agentInvokable: true,
    agentInvokabilityDetails: {},
    agentInvokabilityInvalidOrgChain: false,
    heartbeatWakeOnDemandEnabled: true,
    issueFound: true,
    issueStatus: "in_progress",
    issueAssigneeAgentId: "agent-1",
    issueExecutionRunId: null,
    isNonAssigneeWorkspaceBusyRetry: false,
    reviewParticipant: NO_REVIEW_PARTICIPANT,
    activePauseHold: null,
    dependenciesBlocked: null,
    dispositionRepair: null,
    ...overrides,
  };
}

function queuedRunFacts(overrides: Partial<QueuedRunFacts> = {}): QueuedRunFacts {
  return {
    runId: "run-1",
    runAgentId: "agent-1",
    issueId: "issue-1",
    retryReasonKind: "other",
    issueFound: true,
    issueStatus: "in_progress",
    issueAssigneeAgentId: "agent-1",
    issueExecutionRunId: "run-1",
    isResolvedInteractionContinuation: false,
    isInteractionWake: false,
    isAuthorizedSourceScopedRecovery: false,
    isNonAssigneeWorkspaceBusyRetry: false,
    resumeIntent: false,
    wakeCommentIdPresent: false,
    continuationParkApplies: false,
    continuationParksExecutor: false,
    continuationSummaryBody: null,
    wakeReason: null,
    retryReason: null,
    reviewParticipant: NO_REVIEW_PARTICIPANT,
    ...overrides,
  };
}

function fakeScheduledRetryReader(
  factsResult: LoadGateFactsResult,
  dueRuns: DueRetryRun[] = [],
): ScheduledRetryReader & { calls: LoadGateFactsInput[] } {
  const calls: LoadGateFactsInput[] = [];
  return {
    calls,
    async loadGateFacts(input) {
      calls.push(input);
      return factsResult;
    },
    async listDueRetries() {
      return dueRuns;
    },
  };
}

function fakeWriter(overrides: Partial<RunDispatchWriter> = {}): RunDispatchWriter & {
  promoteCalls: unknown[];
  cancelSuppressedCalls: unknown[];
  cancelStaleCalls: unknown[];
  promoteOrCancelCalls: unknown[];
} {
  const promoteCalls: unknown[] = [];
  const cancelSuppressedCalls: unknown[] = [];
  const cancelStaleCalls: unknown[] = [];
  const promoteOrCancelCalls: unknown[] = [];
  return {
    promoteCalls,
    cancelSuppressedCalls,
    cancelStaleCalls,
    promoteOrCancelCalls,
    async promoteDueRetry(input) {
      promoteCalls.push(input);
      return { applied: true, run: { id: input.runId, status: "queued" }, postCommitEffects: [] };
    },
    async cancelSuppressedRetry(input) {
      cancelSuppressedCalls.push(input);
      return { applied: true, run: { id: input.runId, status: "cancelled" } };
    },
    async cancelStaleQueuedRun(input) {
      cancelStaleCalls.push(input);
      return { applied: true, run: { id: input.runId, status: "cancelled" }, postCommitEffects: [] };
    },
    async promoteOrCancelDueRetry(input) {
      promoteOrCancelCalls.push(input);
      return { outcome: "promoted", run: { id: input.runId, status: "queued" }, postCommitEffects: [] };
    },
    ...overrides,
  };
}

function fakeQueuedRunReader(facts: QueuedRunFacts): QueuedRunReader & { calls: LoadStalenessFactsInput[] } {
  const calls: LoadStalenessFactsInput[] = [];
  return {
    calls,
    async loadStalenessFacts(input) {
      calls.push(input);
      return facts;
    },
  };
}

const baseInput = {
  runId: "run-1",
  companyId: "company-1",
  agentId: "agent-1",
  contextSnapshot: {},
  scheduledRetryReason: null,
  wakeupRequestId: null,
};

describe("createPromoteScheduledRetry", () => {
  // The gate decision and the promote-or-cancel write both live inside the
  // writer's `promoteOrCancelDueRetry` now (one transaction with the issue
  // row locked for its duration — see `postgres.ts`); `domain/policy.test.ts`
  // covers the gate branches and `postgres.test.ts` covers the DB wiring.
  // This use case is a thin adapter call, so its own tests only prove the
  // input mapping and that the writer's outcome passes through unchanged.
  it("maps its input onto the writer's atomic operation and returns its outcome verbatim", async () => {
    const writer = fakeWriter();

    const result = await createPromoteScheduledRetry({ writer })(baseInput);

    expect(result.outcome).toBe("promoted");
    expect(writer.promoteOrCancelCalls).toHaveLength(1);
    expect(writer.promoteOrCancelCalls[0]).toMatchObject({
      runId: baseInput.runId,
      companyId: baseInput.companyId,
      agentId: baseInput.agentId,
      contextSnapshot: baseInput.contextSnapshot,
      scheduledRetryReason: baseInput.scheduledRetryReason,
      wakeupRequestId: baseInput.wakeupRequestId,
    });
    expect((writer.promoteOrCancelCalls[0] as { now: Date }).now).toBeInstanceOf(Date);
  });

  it("defaults now to the current time when the caller omits it", async () => {
    const before = Date.now();
    const writer = fakeWriter();

    await createPromoteScheduledRetry({ writer })(baseInput);
    const after = Date.now();

    const passedNow = (writer.promoteOrCancelCalls[0] as { now: Date }).now.getTime();
    expect(passedNow).toBeGreaterThanOrEqual(before);
    expect(passedNow).toBeLessThanOrEqual(after);
  });

  it("passes an explicit now through instead of overriding it", async () => {
    const explicitNow = new Date("2026-01-01T00:00:00.000Z");
    const writer = fakeWriter();

    await createPromoteScheduledRetry({ writer })({ ...baseInput, now: explicitNow });

    expect((writer.promoteOrCancelCalls[0] as { now: Date }).now).toBe(explicitNow);
  });

  it("returns a cancellation outcome from the writer unchanged", async () => {
    const writer = fakeWriter({
      promoteOrCancelDueRetry: vi.fn(async () => ({
        outcome: "gate_suppressed" as const,
        run: { id: "run-1", status: "cancelled" },
        reason: "Scheduled retry suppressed because the agent is not invokable",
        errorCode: "agent_not_invokable" as const,
      })),
    });

    const result = await createPromoteScheduledRetry({ writer })(baseInput);

    expect(result).toEqual({
      outcome: "gate_suppressed",
      run: { id: "run-1", status: "cancelled" },
      reason: "Scheduled retry suppressed because the agent is not invokable",
      errorCode: "agent_not_invokable",
    });
  });

  it("returns a lost-race outcome from the writer unchanged", async () => {
    const writer = fakeWriter({
      promoteOrCancelDueRetry: vi.fn(async () => ({ outcome: "not_promoted" as const, run: null })),
    });

    const result = await createPromoteScheduledRetry({ writer })(baseInput);

    expect(result).toEqual({ outcome: "not_promoted", run: null });
  });
});

describe("createPromoteDueScheduledRetries", () => {
  function dueRun(runId: string): DueRetryRun {
    return {
      runId,
      companyId: "company-1",
      agentId: "agent-1",
      contextSnapshot: {},
      scheduledRetryReason: null,
      wakeupRequestId: null,
    };
  }

  it("keeps the due order and stops at 50 runs", async () => {
    const dueRuns = Array.from({ length: 75 }, (_, i) => dueRun(`run-${i}`));
    const reader = fakeScheduledRetryReader({ agentFound: true, facts: scheduledRetryFacts() }, dueRuns);
    const writer = fakeWriter();
    const promoteScheduledRetry = createPromoteScheduledRetry({ writer });
    const promoteDueScheduledRetries = createPromoteDueScheduledRetries({ reader, promoteScheduledRetry });

    const result = await promoteDueScheduledRetries({ cutoff: null });

    expect(result.promoted).toBe(50);
    expect(result.runIds).toEqual(dueRuns.slice(0, 50).map((r) => r.runId));
  });
});

describe("createCancelStaleQueuedRun", () => {
  it("cancels only when the decision is stale", async () => {
    const reader = fakeQueuedRunReader(queuedRunFacts({ issueFound: true }));
    const writer = fakeWriter();
    const cancelStaleQueuedRun = createCancelStaleQueuedRun({ reader, writer });

    const result = await cancelStaleQueuedRun({
      runId: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      contextSnapshot: {},
      scheduledRetryReason: null,
      wakeupRequestId: null,
      resultJson: null,
      expectedStatus: "queued",
    });

    expect(result.outcome).toBe("not_stale");
    expect(writer.cancelStaleCalls).toHaveLength(0);
  });

  it("cancels the run when the decision is stale", async () => {
    const reader = fakeQueuedRunReader(queuedRunFacts({ issueFound: false }));
    const writer = fakeWriter();
    const cancelStaleQueuedRun = createCancelStaleQueuedRun({ reader, writer });

    const result = await cancelStaleQueuedRun({
      runId: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      contextSnapshot: {},
      scheduledRetryReason: null,
      wakeupRequestId: null,
      resultJson: null,
      expectedStatus: "queued",
    });

    expect(result.outcome).toBe("cancelled");
    expect(writer.cancelStaleCalls).toHaveLength(1);
    if (result.outcome === "cancelled") {
      expect(result.errorCode).toBe("issue_not_found");
    }
  });

  it("reports a lost race instead of overwriting a status the caller did not expect", async () => {
    const reader = fakeQueuedRunReader(queuedRunFacts({ issueFound: false }));
    const writer = fakeWriter({
      cancelStaleQueuedRun: vi.fn(async () => ({ applied: false as const })),
    });
    const cancelStaleQueuedRun = createCancelStaleQueuedRun({ reader, writer });

    const result = await cancelStaleQueuedRun({
      runId: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      contextSnapshot: {},
      scheduledRetryReason: null,
      wakeupRequestId: null,
      resultJson: null,
      expectedStatus: "queued",
    });

    expect(result).toEqual({ outcome: "lost_race" });
  });
});

describe("createCancelDecidedStaleQueuedRun", () => {
  it("writes the cancellation for a decision the caller already made", async () => {
    const writer = fakeWriter();
    const cancelDecidedStaleQueuedRun = createCancelDecidedStaleQueuedRun({ writer });

    const result = await cancelDecidedStaleQueuedRun({
      runId: "run-1",
      companyId: "company-1",
      issueId: "issue-1",
      wakeupRequestId: null,
      resultJson: null,
      decision: {
        stale: true,
        errorCode: "issue_execution_lock_changed",
        reason: "lock changed",
        details: {},
      },
      expectedStatus: "running",
    });

    expect(result.outcome).toBe("cancelled");
    if (result.outcome === "cancelled") {
      expect(result.errorCode).toBe("issue_execution_lock_changed");
    }
    expect(writer.cancelStaleCalls).toHaveLength(1);
  });

  it("reports a lost race instead of overwriting a status the caller did not expect", async () => {
    const writer = fakeWriter({
      cancelStaleQueuedRun: vi.fn(async () => ({ applied: false as const })),
    });
    const cancelDecidedStaleQueuedRun = createCancelDecidedStaleQueuedRun({ writer });

    const result = await cancelDecidedStaleQueuedRun({
      runId: "run-1",
      companyId: "company-1",
      issueId: "issue-1",
      wakeupRequestId: null,
      resultJson: null,
      decision: {
        stale: true,
        errorCode: "issue_execution_lock_changed",
        reason: "lock changed",
        details: {},
      },
      expectedStatus: "running",
    });

    expect(result).toEqual({ outcome: "lost_race" });
  });
});

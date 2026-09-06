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
} {
  const promoteCalls: unknown[] = [];
  const cancelSuppressedCalls: unknown[] = [];
  const cancelStaleCalls: unknown[] = [];
  return {
    promoteCalls,
    cancelSuppressedCalls,
    cancelStaleCalls,
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
      return { run: { id: input.runId, status: "cancelled" }, postCommitEffects: [] };
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
  it("calls the writer's promote operation exactly once for an allowed gate", async () => {
    const reader = fakeScheduledRetryReader({ agentFound: true, facts: scheduledRetryFacts({ issueId: null }) });
    const writer = fakeWriter();
    const promote = createPromoteScheduledRetry({ reader, writer });

    const result = await promote(baseInput);

    expect(result.outcome).toBe("promoted");
    expect(writer.promoteCalls).toHaveLength(1);
    expect(writer.cancelSuppressedCalls).toHaveLength(0);
  });

  it("calls the cancel operation for a blocked gate", async () => {
    const reader = fakeScheduledRetryReader({
      agentFound: true,
      facts: scheduledRetryFacts({
        issueId: null,
        budgetBlock: { reason: "over budget", scopeType: "company", scopeId: "company-1" },
      }),
    });
    const writer = fakeWriter();
    const promote = createPromoteScheduledRetry({ reader, writer });

    const result = await promote(baseInput);

    expect(result.outcome).toBe("gate_suppressed");
    expect(writer.cancelSuppressedCalls).toHaveLength(1);
    expect(writer.promoteCalls).toHaveLength(0);
  });

  it("keeps the legacy missing-issue exception: a non-max-turn retry promotes anyway", async () => {
    const reader = fakeScheduledRetryReader({
      agentFound: true,
      facts: scheduledRetryFacts({
        issueId: "issue-missing",
        issueFound: false,
        retryReasonKind: "other",
      }),
    });
    const writer = fakeWriter();
    const promote = createPromoteScheduledRetry({ reader, writer });

    const result = await promote(baseInput);

    expect(result.outcome).toBe("promoted");
    expect(writer.promoteCalls).toHaveLength(1);
    expect(writer.cancelSuppressedCalls).toHaveLength(0);
  });

  it("does not apply the legacy missing-issue exception to a max-turn continuation", async () => {
    const reader = fakeScheduledRetryReader({
      agentFound: true,
      facts: scheduledRetryFacts({
        issueId: "issue-missing",
        issueFound: false,
        retryReasonKind: "max_turn_continuation",
      }),
    });
    const writer = fakeWriter();
    const promote = createPromoteScheduledRetry({ reader, writer });

    const result = await promote(baseInput);

    expect(result.outcome).toBe("gate_suppressed");
    expect(writer.cancelSuppressedCalls).toHaveLength(1);
  });

  it("returns a lost-compare-and-set outcome when the writer reports no row", async () => {
    const reader = fakeScheduledRetryReader({ agentFound: true, facts: scheduledRetryFacts({ issueId: null }) });
    const writer = fakeWriter({
      promoteDueRetry: vi.fn(async () => ({ applied: false as const })),
    });
    const promote = createPromoteScheduledRetry({ reader, writer });

    const result = await promote(baseInput);

    expect(result).toEqual({ outcome: "not_promoted", run: null });
  });

  it("returns a lost-compare-and-set outcome when a suppressed-retry cancel loses its race", async () => {
    const reader = fakeScheduledRetryReader({
      agentFound: true,
      facts: scheduledRetryFacts({
        issueId: null,
        budgetBlock: { reason: "over budget", scopeType: "company", scopeId: "company-1" },
      }),
    });
    const writer = fakeWriter({
      cancelSuppressedRetry: vi.fn(async () => ({ applied: false as const })),
    });
    const promote = createPromoteScheduledRetry({ reader, writer });

    const result = await promote(baseInput);

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
    const reader = fakeScheduledRetryReader(
      { agentFound: true, facts: scheduledRetryFacts({ issueId: null }) },
      dueRuns,
    );
    const writer = fakeWriter();
    const promoteScheduledRetry = createPromoteScheduledRetry({ reader, writer });
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
    });

    expect(result.outcome).toBe("cancelled");
    expect(writer.cancelStaleCalls).toHaveLength(1);
    if (result.outcome === "cancelled") {
      expect(result.errorCode).toBe("issue_not_found");
    }
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
    });

    expect(result.outcome).toBe("cancelled");
    expect(result.errorCode).toBe("issue_execution_lock_changed");
    expect(writer.cancelStaleCalls).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createReleaseIssueExecution } from "./use-cases.js";
import { WakeQueueApplicationError } from "./types.js";
import type {
  DeferredWakeCandidate,
  InvokableAgentSnapshot,
  IssueLockWriter,
  IssueSnapshot,
  PromoteDeferredWakeInput,
  RecoveryEscalationPort,
  RunSnapshot,
  RunSummary,
  WakeQueueReader,
  WakeQueueWriter,
} from "./ports.js";

const RUN: RunSnapshot = {
  id: "run-1",
  companyId: "company-1",
  agentId: "finishing-agent",
  status: "failed",
  runtimeMode: "process",
  errorCode: null,
  responsibleUserId: "user-1",
  contextSnapshot: {},
  configurationIncompletePayload: null,
};

const ISSUE: IssueSnapshot = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "PAP-1",
  status: "in_progress",
  assigneeAgentId: "finishing-agent",
  assigneeUserId: null,
  hiddenAt: null,
  originKind: null,
  monitorNextCheckAt: null,
  executionState: null,
  responsibleUserId: null,
  parentId: null,
  originId: null,
  originRunId: null,
};

const AGENT: InvokableAgentSnapshot = {
  id: "deferred-agent",
  companyId: "company-1",
  name: "Deferred Agent",
  invokable: true,
};

function wakeCandidate(overrides: Partial<DeferredWakeCandidate> = {}): DeferredWakeCandidate {
  return {
    id: overrides.id ?? "wake-1",
    companyId: "company-1",
    agentId: "deferred-agent",
    reason: "issue_commented",
    source: "automation",
    triggerDetail: null,
    requestedByActorType: "user",
    requestedByActorId: "actor-1",
    payload: {},
    queuedCommentIds: [],
    preservesIndependentContinuation: false,
    deferredContextSeed: {},
    deferredCommentIds: [],
    wakeReason: "issue_commented",
    ...overrides,
  };
}

function runSummary(id: string): RunSummary {
  return {
    id,
    companyId: "company-1",
    agentId: "deferred-agent",
    invocationSource: "automation",
    triggerDetail: null,
    wakeupRequestId: `wakeup-${id}`,
  };
}

function createFakeReader(overrides: Partial<WakeQueueReader> = {}): WakeQueueReader {
  return {
    findInvokableAgent: vi.fn(async () => AGENT),
    resolveResponsibleUserId: vi.fn(async () => "user-1"),
    getRoutineEnv: vi.fn(async () => ({ routineId: null, env: null, responsibleUserId: null })),
    resolveSessionBeforeForWakeup: vi.fn(async () => null),
    ...overrides,
  };
}

function createFakeWriter(overrides: Partial<WakeQueueWriter> = {}): WakeQueueWriter {
  return {
    claimNextDeferredWake: vi.fn(async () => null),
    getQueuedCommentLiveness: vi.fn(async () => ({ liveNonSelfCommentIds: [], containedSelfAuthoredComment: false })),
    cancelDeferredWake: vi.fn(async () => true),
    normalizeDeferredWakeCommentIds: vi.fn(async (input) => wakeCandidate({ id: input.wakeId, queuedCommentIds: input.liveCommentIds })),
    failDeferredWake: vi.fn(async () => true),
    getPauseHoldFacts: vi.fn(async () => ({
      activePauseHold: false,
      treeHoldInteractionWake: false,
      holdId: null,
      rootIssueId: null,
      mode: null,
      reason: null,
      releasePolicy: null,
    })),
    getCommentSelfAuthorship: vi.fn(async () => ({ allSelfAuthored: false })),
    reopenIssue: vi.fn(async () => null),
    claimDeferredWakeForPromotion: vi.fn(async () => true),
    finalizePromotedWake: vi.fn(async (input) => runSummary(input.wakeId)),
    hasExistingExecutionPath: vi.fn(async () => false),
    hasExplicitBlockerPath: vi.fn(async () => false),
    isAutomaticRecoverySuppressedByPauseHold: vi.fn(async () => false),
    buildBlockedRecoveryNotice: vi.fn(async () => ({ notice: {}, recoveryCause: null })),
    queueReviewParticipantRecoveryRun: vi.fn(async () => runSummary("review-recovery")),
    queueImmediateRecoveryRun: vi.fn(async () => runSummary("immediate-recovery")),
    ...overrides,
  };
}

function createFakeIssueLock(reader: WakeQueueReader, writer: WakeQueueWriter): IssueLockWriter {
  return {
    withIssueExecutionLock: vi.fn(async (_input, fn) => {
      const result = await fn({ primaryIssue: ISSUE, run: RUN }, { reader, writer });
      return { ...result, run: RUN };
    }),
  };
}

function createFakeRecovery(): RecoveryEscalationPort {
  return {
    escalateStrandedAssignedIssue: vi.fn(async () => {}),
    escalateStrandedRecoveryIssueInPlace: vi.fn(async () => {}),
  };
}

describe("releaseIssueExecution", () => {
  it("processes the deferred wakes in requestedAt order", async () => {
    const claimOrder: string[] = [];
    const queue = [wakeCandidate({ id: "wake-earliest" }), wakeCandidate({ id: "wake-latest" })];
    const writer = createFakeWriter({
      claimNextDeferredWake: vi.fn(async () => {
        const next = queue.shift() ?? null;
        if (next) claimOrder.push(next.id);
        return next;
      }),
    });
    // Every wake fails invokability so the loop keeps draining without promoting.
    const reader = createFakeReader({ findInvokableAgent: vi.fn(async () => null) });
    const issueLock = createFakeIssueLock(reader, writer);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(claimOrder).toEqual(["wake-earliest", "wake-latest"]);
    expect(writer.failDeferredWake).toHaveBeenCalledTimes(2);
  });

  it("stops the loop after the first promotion", async () => {
    const claimNextDeferredWake = vi.fn(async () => wakeCandidate({ id: "wake-promotes" }));
    const writer = createFakeWriter({ claimNextDeferredWake });
    const reader = createFakeReader();
    const issueLock = createFakeIssueLock(reader, writer);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(result.outcome.kind).toBe("promoted");
    expect(claimNextDeferredWake).toHaveBeenCalledTimes(1);
  });

  it("continues the loop after a cancel outcome, a fail outcome, and a normalize outcome, then promotes", async () => {
    const queue = [
      // cancel_empty: queued comments, none live, no independent continuation.
      wakeCandidate({ id: "wake-cancel", queuedCommentIds: ["c1"] }),
      // fail_not_invokable: agent lookup misses for this one wake only.
      wakeCandidate({ id: "wake-fail", agentId: "uninvokable-agent" }),
      // normalize: queued comments differ from the live set, then promotes.
      wakeCandidate({ id: "wake-normalize", queuedCommentIds: ["c1", "c2"] }),
    ];
    const claimNextDeferredWake = vi.fn(async () => queue.shift() ?? null);
    const findInvokableAgent = vi.fn(async (input: { agentId: string }) =>
      input.agentId === "deferred-agent" ? AGENT : null,
    );
    const getQueuedCommentLiveness = vi.fn(async (input: { queuedCommentIds: string[] }) =>
      input.queuedCommentIds.length === 1
        ? { liveNonSelfCommentIds: [], containedSelfAuthoredComment: false }
        : { liveNonSelfCommentIds: ["c2"], containedSelfAuthoredComment: false },
    );
    const writer = createFakeWriter({ claimNextDeferredWake, getQueuedCommentLiveness });
    const reader = createFakeReader({ findInvokableAgent });
    const issueLock = createFakeIssueLock(reader, writer);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(writer.cancelDeferredWake).toHaveBeenCalledTimes(1);
    expect(writer.failDeferredWake).toHaveBeenCalledTimes(1);
    expect(writer.normalizeDeferredWakeCommentIds).toHaveBeenCalledTimes(1);
    expect(claimNextDeferredWake).toHaveBeenCalledTimes(3);
    expect(result.outcome.kind).toBe("promoted");
  });

  it("returns the post-commit effects as data without running them", async () => {
    const writer = createFakeWriter({ claimNextDeferredWake: vi.fn(async () => wakeCandidate()) });
    const reader = createFakeReader();
    const issueLock = createFakeIssueLock(reader, writer);
    const recovery = createFakeRecovery();
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(result.postCommitEffects).toEqual([{ kind: "run_queued", run: runSummary("wake-1") }]);
    expect(recovery.escalateStrandedAssignedIssue).not.toHaveBeenCalled();
    expect(recovery.escalateStrandedRecoveryIssueInPlace).not.toHaveBeenCalled();
  });

  it("carries the deferred wake's raw issue, interaction, execution-stage, and accepted-plan context onto the promoted run, and clears only the rendered text projections", async () => {
    const finalizePromotedWake = vi.fn(async (input: PromoteDeferredWakeInput) => runSummary(input.wakeId));
    const writer = createFakeWriter({
      claimNextDeferredWake: vi.fn(async () =>
        wakeCandidate({
          deferredContextSeed: {
            issueId: ISSUE.id,
            wakeCommentIds: ["comment-1"],
            // A queue-time render from a prior coalesced run. Promotion must
            // not persist this alongside the current (unrelated) comment id.
            paperclipTaskMarkdown: "queue-time markdown",
            paperclipTaskMarkdownCompact: "queue-time compact markdown",
            paperclipWake: { commentId: "comment-1" },
            executionStage: { stage: "review" },
            planReviewInteraction: { acceptedTargetRevision: { revisionId: "revision-1" } },
            acceptedPlanWakeRouting: { targetAgentId: "agent-1" },
          },
        }),
      ),
      finalizePromotedWake,
    });
    const reader = createFakeReader();
    const issueLock = createFakeIssueLock(reader, writer);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(result.outcome.kind).toBe("promoted");
    expect(finalizePromotedWake).toHaveBeenCalledTimes(1);
    const promotedContextSnapshot = finalizePromotedWake.mock.calls[0]![0].contextSnapshot;
    // The rendered text is cleared; `executeRun` rebuilds it, with proper
    // trust-based redaction, from the current issue and comment rows before
    // the run dispatches.
    expect(promotedContextSnapshot.paperclipTaskMarkdown).toBeUndefined();
    expect(promotedContextSnapshot.paperclipTaskMarkdownCompact).toBeUndefined();
    expect(promotedContextSnapshot.paperclipWake).toBeUndefined();
    // The raw fields that render depends on are not dropped.
    expect(promotedContextSnapshot.issueId).toBe(ISSUE.id);
    expect(promotedContextSnapshot.executionStage).toEqual({ stage: "review" });
    expect(promotedContextSnapshot.planReviewInteraction).toEqual({
      acceptedTargetRevision: { revisionId: "revision-1" },
    });
    expect(promotedContextSnapshot.acceptedPlanWakeRouting).toEqual({ targetAgentId: "agent-1" });
  });

  it("never reopens the issue when the promotion claim loses the race, and moves on to the next wake", async () => {
    const doneIssue: IssueSnapshot = { ...ISSUE, status: "done" };
    const queue = [
      // Carries a comment that would reopen the done issue, but the
      // promotion claim below loses the race before that reopen can run.
      wakeCandidate({
        id: "wake-lost-race",
        deferredCommentIds: ["c1"],
        requestedByActorType: "user",
      }),
      wakeCandidate({ id: "wake-promotes" }),
    ];
    const claimNextDeferredWake = vi.fn(async () => queue.shift() ?? null);
    const claimDeferredWakeForPromotion = vi.fn(async ({ wakeId }: { wakeId: string }) => wakeId !== "wake-lost-race");
    const reopenIssue = vi.fn(async () => null);
    const writer = createFakeWriter({ claimNextDeferredWake, claimDeferredWakeForPromotion, reopenIssue });
    const reader = createFakeReader();
    const issueLock: IssueLockWriter = {
      withIssueExecutionLock: vi.fn(async (_input, fn) => {
        const result = await fn({ primaryIssue: doneIssue, run: RUN }, { reader, writer });
        return { ...result, run: RUN };
      }),
    };
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(reopenIssue).not.toHaveBeenCalled();
    expect(claimDeferredWakeForPromotion).toHaveBeenCalledTimes(2);
    expect(result.outcome.kind).toBe("promoted");
    expect(result.postCommitEffects).toEqual([{ kind: "run_queued", run: runSummary("wake-promotes") }]);
  });

  it("throws WakeQueueApplicationError with code responsible_user_unresolved when the responsible user cannot resolve", async () => {
    const writer = createFakeWriter({ claimNextDeferredWake: vi.fn(async () => wakeCandidate()) });
    const reader = createFakeReader({ resolveResponsibleUserId: vi.fn(async () => null) });
    const issueLock = createFakeIssueLock(reader, writer);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    await expect(
      releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() }),
    ).rejects.toMatchObject({
      constructor: WakeQueueApplicationError,
      code: "responsible_user_unresolved",
    });
  });

  it("escalates through the recovery port for a blocked outcome, after the transaction resolves", async () => {
    const writer = createFakeWriter({
      claimNextDeferredWake: vi.fn(async () => null),
      hasExistingExecutionPath: vi.fn(async () => false),
      isAutomaticRecoverySuppressedByPauseHold: vi.fn(async () => false),
      buildBlockedRecoveryNotice: vi.fn(async () => ({ notice: { kind: "immediate_execution_path" }, recoveryCause: "immediate_execution_path" })),
    });
    // The recovery agent (the finishing run's own agent) is not invokable, which forces "blocked".
    const reader = createFakeReader({ findInvokableAgent: vi.fn(async () => null) });
    const issueLock = createFakeIssueLock(reader, writer);
    const recovery = createFakeRecovery();
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(result.outcome.kind).toBe("blocked");
    expect(recovery.escalateStrandedAssignedIssue).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createAdmitWakeBehindIssueExecution, createReleaseIssueExecution } from "./use-cases.js";
import { mergeCoalescedContextSnapshot } from "../../../services/heartbeat/run-preparation.js";
import { queuedCommentIdsFromWakePayload, withQueuedCommentIdsInWakePayload } from "../../../services/issue-queued-comment-queue.js";
import { extractWakeCommentIds } from "../../run-dispatch/index.js";
import { deferredWakePreservesIndependentContinuation, hasInteractionContinuationWakeContext } from "../domain/context.js";
import { EXECUTION_STAGE_WAKE_REASONS } from "../domain/execution-wake-freshness.js";
import type { AdmitWakeBehindIssueExecutionInput } from "./use-cases.js";
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
  TransactionScope,
  WakeAdmissionActiveExecutionRun,
  WakeAdmissionHeartbeatHelpers,
  WakeAdmissionReader,
  WakeAdmissionWriter,
  WakeQueueHost,
  WakeQueueTransaction,
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
  identifier: "ISSUE-1",
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

function createFakeHost(overrides: Partial<WakeQueueHost> = {}): WakeQueueHost {
  return {
    resolveResponsibleUserId: vi.fn(async () => "user-1"),
    getRoutineEnv: vi.fn(async () => ({ routineId: null, env: null, responsibleUserId: null })),
    resolveSessionBeforeForWakeup: vi.fn(async () => null),
    ...overrides,
  };
}

function createFakeTransaction(overrides: Partial<WakeQueueTransaction> = {}): WakeQueueTransaction {
  return {
    findInvokableAgent: vi.fn(async () => AGENT),
    isCompletedOnboardingHandoffWake: vi.fn(async () => false),
    findNextDeferredWake: vi.fn(async () => null),
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
    isCompletedDelegationMention: vi.fn(async () => false),
    reopenIssue: vi.fn(async () => null),
    claimDeferredWakeForPromotion: vi.fn(async () => true),
    finalizePromotedWake: vi.fn(async (input) => runSummary(input.wakeId)),
    hasExistingExecutionPath: vi.fn(async () => false),
    hasExplicitBlockerPath: vi.fn(async () => false),
    isAutomaticRecoverySuppressedByPauseHold: vi.fn(async () => false),
    isImmediateRecoverySourceBlocked: vi.fn(async () => false),
    queueReviewParticipantRecoveryRun: vi.fn(async () => runSummary("review-recovery")),
    queueImmediateRecoveryRun: vi.fn(async () => runSummary("immediate-recovery")),
    ...overrides,
  };
}

function createFakeIssueLock(host: WakeQueueHost, transaction: WakeQueueTransaction, issue = ISSUE, run = RUN): IssueLockWriter {
  return {
    withIssueExecutionLock: vi.fn(async (_input, fn) => {
      const result = await fn({ primaryIssue: issue, run }, { host, transaction });
      return { ...result, run };
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
  it.each([false, true])("preserves a paused head without blocking an eligible follower (%s)", async withFollower => {
    const paused = wakeCandidate({ id: "paused-wake", wakeReason: "issue_comment_mentioned", queuedCommentIds: ["paused-comment"] });
    const ready = wakeCandidate({ id: "ready-wake", agentId: "ready-agent", queuedCommentIds: ["ready-comment"] });
    const pending = withFollower ? [paused, ready] : [paused];
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async input => pending.find(wake => !input.excludedWakeIds?.includes(wake.id)) ?? null),
      findInvokableAgent: vi.fn(async input => input.agentId === paused.agentId
        ? { ...AGENT, invokable: false, paused: true } : { ...AGENT, id: ready.agentId }),
      getQueuedCommentLiveness: vi.fn(async input => ({ liveNonSelfCommentIds: input.queuedCommentIds, containedSelfAuthoredComment: false })),
    });
    const release = createReleaseIssueExecution({ issueLock: createFakeIssueLock(createFakeHost(), transaction,
      { ...ISSUE, status: "blocked", assigneeAgentId: ready.agentId }, { ...RUN, status: "succeeded" }), recovery: createFakeRecovery() });
    const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date(), resumeStrandedQueue: true });
    expect(result.outcome.kind).toBe(withFollower ? "promoted" : "released");
    expect(transaction.failDeferredWake).not.toHaveBeenCalled();
    expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
    expect(transaction.normalizeDeferredWakeCommentIds).not.toHaveBeenCalled();
    expect(transaction.findNextDeferredWake).toHaveBeenNthCalledWith(2, expect.objectContaining({ excludedWakeIds: [paused.id] }));
    if (withFollower) expect(transaction.finalizePromotedWake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ wakeId: ready.id }));
    else expect(transaction.finalizePromotedWake).not.toHaveBeenCalled();
  });

  it.each(["closing", "mixed_comments", "explicit_resume", "interaction", "other_source_task", "parent_open"])(
    "checks late completed-delegation mentions without dropping independent input (%s)", async (scenario) => {
      const originalCommentIds = ["closing-comment", "second-comment"];
      const candidate = wakeCandidate({
        reason: "issue_comment_mentioned", wakeReason: "issue_comment_mentioned",
        requestedByActorType: "agent", requestedByActorId: RUN.agentId,
        queuedCommentIds: [originalCommentIds[0]], deferredCommentIds: originalCommentIds,
        preservesIndependentContinuation: scenario === "explicit_resume",
        payload: scenario === "interaction" ? { mutation: "interaction" } : {},
        deferredContextSeed: scenario === "explicit_resume" ? { resumeIntent: true } : {},
      });
      const queue = [candidate];
      const transaction = createFakeTransaction({
        findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
        isCompletedDelegationMention: vi.fn(async () => scenario !== "mixed_comments"),
        getQueuedCommentLiveness: vi.fn(async () => ({ liveNonSelfCommentIds: [originalCommentIds[0]], containedSelfAuthoredComment: false })),
      });
      const issue = { ...ISSUE, status: scenario === "parent_open" ? "in_progress" : "done" };
      const run = { ...RUN, status: "succeeded", contextSnapshot: { issueId: scenario === "other_source_task" ? "other-issue" : ISSUE.id } };
      const release = createReleaseIssueExecution({
        issueLock: createFakeIssueLock(createFakeHost(), transaction, issue, run), recovery: createFakeRecovery(),
      });
      const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });
      if (scenario === "closing" || scenario === "mixed_comments") {
        expect(transaction.isCompletedDelegationMention).toHaveBeenCalledWith({
          companyId: RUN.companyId, issueId: ISSUE.id, finishingRunId: RUN.id,
          wakeAgentId: AGENT.id, commentIds: originalCommentIds,
        });
      } else {
        expect(transaction.isCompletedDelegationMention).not.toHaveBeenCalled();
      }
      if (scenario === "closing") {
        expect(result.outcome.kind).toBe("released");
        expect(transaction.cancelDeferredWake).toHaveBeenCalledTimes(1);
        expect(transaction.claimDeferredWakeForPromotion).not.toHaveBeenCalled();
        expect(transaction.finalizePromotedWake).not.toHaveBeenCalled();
      } else {
        expect(result.outcome.kind).toBe("promoted");
        expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves an accepted assignment when a legacy mention was coalesced last", async () => {
    const assignedIssue = { ...ISSUE, assigneeAgentId: AGENT.id };
    const queue = [wakeCandidate({
      source: "assignment", reason: "issue_execution_deferred", wakeReason: "issue_comment_mentioned",
      deferredContextSeed: { issueId: ISSUE.id, wakeReason: "issue_comment_mentioned", source: "comment.mention" },
    })];
    const transaction = createFakeTransaction({ findNextDeferredWake: vi.fn(async () => queue.shift() ?? null) });
    const release = createReleaseIssueExecution({
      issueLock: createFakeIssueLock(createFakeHost(), transaction, assignedIssue), recovery: createFakeRecovery(),
    });
    expect((await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() })).outcome.kind).toBe("promoted");
    expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
    expect(transaction.finalizePromotedWake).toHaveBeenCalledWith(expect.objectContaining({
      source: "assignment", deferredAgent: expect.objectContaining({ id: AGENT.id }),
    }));
  });

  it("preserves the former owner's queue for handoff adoption while draining the new owner's wake", async () => {
    const stale = wakeCandidate({ agentId: RUN.agentId, queuedCommentIds: ["saved-user-direction"] });
    const current = wakeCandidate({ id: "wake-new-owner", agentId: "new-agent" });
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async (input: { companyId: string; issueId: string; excludedWakeIds?: string[] }) =>
        input.excludedWakeIds?.includes(stale.id) ? current : stale),
      getQueuedCommentLiveness: vi.fn(async () => ({ liveNonSelfCommentIds: ["saved-user-direction"], containedSelfAuthoredComment: false })),
    });
    const release = createReleaseIssueExecution({
      issueLock: createFakeIssueLock(createFakeHost(), transaction, { ...ISSUE, assigneeAgentId: "new-agent" }),
      recovery: createFakeRecovery(),
    });
    const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });
    expect(result.outcome.kind).toBe("promoted");
    expect(transaction.finalizePromotedWake).toHaveBeenCalledWith(expect.objectContaining({ wakeId: current.id }));
    expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
  });

  it.each(["done", "in_progress"])("does not promote a former assignee's saved instruction after handoff (%s)", async (status) => {
    const queuedCommentIds = ["saved-user-direction"];
    const queue = [wakeCandidate({
      agentId: "previous-agent",
      reason: "issue_execution_deferred",
      queuedCommentIds,
      deferredCommentIds: queuedCommentIds,
      deferredContextSeed: { wakeReason: "issue_commented", wakeCommentIds: queuedCommentIds },
    })];
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
      getQueuedCommentLiveness: vi.fn(async () => ({ liveNonSelfCommentIds: queuedCommentIds, containedSelfAuthoredComment: false })),
    });
    const release = createReleaseIssueExecution({
      issueLock: createFakeIssueLock(createFakeHost(), transaction, { ...ISSUE, status }),
      recovery: createFakeRecovery(),
    });
    await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date(), suppressImmediateRecovery: true });
    expect(transaction.cancelDeferredWake).toHaveBeenCalledWith(expect.objectContaining({ wakeId: "wake-1" }));
    expect(transaction.claimDeferredWakeForPromotion).not.toHaveBeenCalled();
    expect(transaction.finalizePromotedWake).not.toHaveBeenCalled();
    expect(transaction.reopenIssue).not.toHaveBeenCalled();
  });

  it.each([
    { agentId: ISSUE.assigneeAgentId!, wakeReason: "issue_commented", preservesIndependentContinuation: false, authorizedFailedChatRetry: false },
    { agentId: "mentioned-agent", wakeReason: "issue_comment_mentioned", preservesIndependentContinuation: false, authorizedFailedChatRetry: false },
    { agentId: "interaction-agent", wakeReason: "issue_commented", preservesIndependentContinuation: true, authorizedFailedChatRetry: false },
    { agentId: "interaction-payload-agent", wakeReason: "issue_commented", preservesIndependentContinuation: false, authorizedFailedChatRetry: false, payload: { mutation: "interaction" } },
    { agentId: "chat-agent", wakeReason: "issue_commented", preservesIndependentContinuation: false, authorizedFailedChatRetry: true },
  ])("preserves the independently authorized $agentId/$wakeReason wake", async (authority) => {
    const queuedCommentIds = ["saved-user-direction"];
    const queue = [wakeCandidate({ ...authority, queuedCommentIds, deferredCommentIds: queuedCommentIds })];
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
      getQueuedCommentLiveness: vi.fn(async () => ({ liveNonSelfCommentIds: queuedCommentIds, containedSelfAuthoredComment: false })),
    });
    const release = createReleaseIssueExecution({ issueLock: createFakeIssueLock(createFakeHost(), transaction), recovery: createFakeRecovery() });
    expect((await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() })).outcome.kind).toBe("promoted");
    expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "preserves failed-chat retry input without reopening only with adapter proof: %s",
    async (authorizedFailedChatRetry) => {
      const queue = [
        wakeCandidate({
          agentId: authorizedFailedChatRetry ? AGENT.id : ISSUE.assigneeAgentId!,
          authorizedFailedChatRetry,
          queuedCommentIds: ["original-comment"],
          deferredCommentIds: ["original-comment"],
          deferredContextSeed: {
            issueId: ISSUE.id,
            wakeCommentIds: ["original-comment"],
            retryOfRunId: "original-failed-run",
            chatFailedRunRetry: { requestId: "exact-request" },
          },
        }),
      ];
      const transaction = createFakeTransaction({
        findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
      });
      const host = createFakeHost();
      const release = createReleaseIssueExecution({
        issueLock: createFakeIssueLock(host, transaction, {
          ...ISSUE,
          status: "done",
        }),
        recovery: createFakeRecovery(),
      });

      const result = await release({
        companyId: RUN.companyId,
        runId: RUN.id,
        now: new Date(),
      });

      expect(transaction.normalizeDeferredWakeCommentIds).not.toHaveBeenCalled();
      expect(transaction.reopenIssue).not.toHaveBeenCalled();
      if (authorizedFailedChatRetry) {
        expect(transaction.getQueuedCommentLiveness).not.toHaveBeenCalled();
        expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
        expect(transaction.finalizePromotedWake).toHaveBeenCalledWith(
          expect.objectContaining({
            authorizedFailedChatRetry: true,
            contextSnapshot: expect.objectContaining({
              wakeCommentIds: ["original-comment"],
              retryOfRunId: "original-failed-run",
              chatFailedRunRetry: { requestId: "exact-request" },
            }),
          }),
        );
        expect(result.outcome.kind).toBe("promoted");
      } else {
        expect(transaction.getQueuedCommentLiveness).toHaveBeenCalledTimes(1);
        expect(transaction.cancelDeferredWake).toHaveBeenCalledTimes(1);
        expect(transaction.finalizePromotedWake).not.toHaveBeenCalled();
        expect(result.outcome.kind).toBe("released");
      }
    },
  );

  it.each([false, true])(
    "applies an exact source denial only after independent deferred input: %s",
    async (hasDeferredInput) => {
      const transaction = createFakeTransaction({
        findNextDeferredWake: vi.fn(async () =>
          hasDeferredInput ? wakeCandidate() : null,
        ),
        isImmediateRecoverySourceBlocked: vi.fn(async () => true),
      });
      const release = createReleaseIssueExecution({
        issueLock: createFakeIssueLock(createFakeHost(), transaction),
        recovery: createFakeRecovery(),
      });

      const result = await release({
        companyId: RUN.companyId,
        runId: RUN.id,
        now: new Date(),
      });

      expect(transaction.queueImmediateRecoveryRun).not.toHaveBeenCalled();
      if (hasDeferredInput) {
        expect(transaction.isImmediateRecoverySourceBlocked).not.toHaveBeenCalled();
        expect(result.outcome.kind).toBe("promoted");
      } else {
        expect(transaction.isImmediateRecoverySourceBlocked).toHaveBeenCalledWith({
          companyId: RUN.companyId,
          runId: RUN.id,
        });
        expect(result.outcome.kind).toBe("blocked");
      }
    },
  );

  it("processes the deferred wakes in requestedAt order", async () => {
    const claimOrder: string[] = [];
    const queue = [wakeCandidate({ id: "wake-earliest" }), wakeCandidate({ id: "wake-latest" })];
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => {
        const next = queue.shift() ?? null;
        if (next) claimOrder.push(next.id);
        return next;
      }),
      // Every wake fails invokability so the loop keeps draining without promoting.
      findInvokableAgent: vi.fn(async () => null),
    });
    const host = createFakeHost();
    const issueLock = createFakeIssueLock(host, transaction);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(claimOrder).toEqual(["wake-earliest", "wake-latest"]);
    expect(transaction.failDeferredWake).toHaveBeenCalledTimes(2);
  });

  it("stops the loop after the first promotion", async () => {
    const findNextDeferredWake = vi.fn(async () => wakeCandidate({ id: "wake-promotes" }));
    const transaction = createFakeTransaction({ findNextDeferredWake });
    const host = createFakeHost();
    const issueLock = createFakeIssueLock(host, transaction);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(result.outcome.kind).toBe("promoted");
    expect(findNextDeferredWake).toHaveBeenCalledTimes(1);
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
    const findNextDeferredWake = vi.fn(async () => queue.shift() ?? null);
    const findInvokableAgent = vi.fn(async (input: { agentId: string }) =>
      input.agentId === "deferred-agent" ? AGENT : null,
    );
    const getQueuedCommentLiveness = vi.fn(async (input: { queuedCommentIds: string[] }) =>
      input.queuedCommentIds.length === 1
        ? { liveNonSelfCommentIds: [], containedSelfAuthoredComment: false }
        : { liveNonSelfCommentIds: ["c2"], containedSelfAuthoredComment: false },
    );
    const transaction = createFakeTransaction({ findNextDeferredWake, findInvokableAgent, getQueuedCommentLiveness });
    const host = createFakeHost();
    const issueLock = createFakeIssueLock(host, transaction, { ...ISSUE, assigneeAgentId: AGENT.id });
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(transaction.cancelDeferredWake).toHaveBeenCalledTimes(1);
    expect(transaction.failDeferredWake).toHaveBeenCalledTimes(1);
    expect(transaction.normalizeDeferredWakeCommentIds).toHaveBeenCalledTimes(1);
    expect(findNextDeferredWake).toHaveBeenCalledTimes(3);
    expect(result.outcome.kind).toBe("promoted");
  });

  it("rejects with deferred_wake_not_advanced when the queue read returns the same wake id twice, instead of looping forever", async () => {
    // queuedCommentIds with no live comments and no independent continuation
    // routes to "cancel_empty", so the drain calls cancelDeferredWake and
    // discards its result, then reads the queue again for the same row.
    const repeatedCandidate = wakeCandidate({ id: "wake-repeat", queuedCommentIds: ["c1"] });
    const findNextDeferredWake = vi.fn(async () => repeatedCandidate);
    const cancelDeferredWake = vi.fn(async () => false);
    const transaction = createFakeTransaction({ findNextDeferredWake, cancelDeferredWake });
    const host = createFakeHost();
    const issueLock = createFakeIssueLock(host, transaction);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    await expect(
      releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() }),
    ).rejects.toMatchObject({
      constructor: WakeQueueApplicationError,
      code: "deferred_wake_not_advanced",
    });
    expect(findNextDeferredWake).toHaveBeenCalledTimes(2);
  });

  it("returns the post-commit effects as data without running them", async () => {
    const transaction = createFakeTransaction({ findNextDeferredWake: vi.fn(async () => wakeCandidate()) });
    const host = createFakeHost();
    const issueLock = createFakeIssueLock(host, transaction);
    const recovery = createFakeRecovery();
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(result.postCommitEffects).toEqual([{ kind: "run_queued", run: runSummary("wake-1") }]);
    expect(recovery.escalateStrandedAssignedIssue).not.toHaveBeenCalled();
    expect(recovery.escalateStrandedRecoveryIssueInPlace).not.toHaveBeenCalled();
  });

  it("carries the deferred wake's raw issue, interaction, execution-stage, and accepted-plan context onto the promoted run, and clears only the rendered text projections", async () => {
    const finalizePromotedWake = vi.fn(async (input: PromoteDeferredWakeInput) => runSummary(input.wakeId));
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () =>
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
    const host = createFakeHost();
    const issueLock = createFakeIssueLock(host, transaction);
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

  it.each(["done", "cancelled"])("cancels stale assignee continuations before claiming promotion on %s tasks", async (status) => {
    const queue = [wakeCandidate({ agentId: ISSUE.assigneeAgentId!, requestedByActorType: "agent" })];
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
    });
    const release = createReleaseIssueExecution({
      issueLock: createFakeIssueLock(createFakeHost(), transaction, { ...ISSUE, status }),
      recovery: createFakeRecovery(),
    });

    const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });

    expect(transaction.cancelDeferredWake).toHaveBeenCalledWith(expect.objectContaining({
      wakeId: "wake-1",
      reason: "Deferred execution wake no longer applies to a terminal task",
    }));
    expect(transaction.claimDeferredWakeForPromotion).not.toHaveBeenCalled();
    expect(transaction.finalizePromotedWake).not.toHaveBeenCalled();
    expect(result.outcome.kind).toBe("released");
  });

  it.each(["verified", "unverified", "cancelled", "ordinary-task"])("handles a completed onboarding handoff report: %s", async scenario => {
    const queue = [wakeCandidate({ agentId: ISSUE.assigneeAgentId!, requestedByActorType: "system",
      reason: "issue_children_completed", wakeReason: "issue_children_completed",
      deferredContextSeed: { completedChildIssueId: "child", onboardingCompletion: true } })];
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
      isCompletedOnboardingHandoffWake: vi.fn(async () => scenario !== "unverified"),
    });
    const release = createReleaseIssueExecution({
      issueLock: createFakeIssueLock(createFakeHost(), transaction, { ...ISSUE,
        originKind: scenario === "ordinary-task" ? "manual" : "onboarding_first_task",
        status: scenario === "cancelled" ? "cancelled" : "done" }),
      recovery: createFakeRecovery(),
    });
    const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });
    expect(result.outcome.kind).toBe(scenario === "verified" ? "promoted" : "released");
    expect(transaction.reopenIssue).not.toHaveBeenCalled();
    expect(transaction.finalizePromotedWake).toHaveBeenCalledTimes(scenario === "verified" ? 1 : 0);
    expect(transaction.cancelDeferredWake).toHaveBeenCalledTimes(scenario === "verified" ? 0 : 1);
  });

  it("reopens a completed task before promoting its assignee's human follow-up", async () => {
    const queue = [wakeCandidate({
      agentId: ISSUE.assigneeAgentId!,
      requestedByActorType: "user",
      deferredCommentIds: ["human-follow-up"],
    })];
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
      reopenIssue: vi.fn(async () => ({ ...ISSUE, status: "todo" })),
    });
    const release = createReleaseIssueExecution({
      issueLock: createFakeIssueLock(createFakeHost(), transaction, { ...ISSUE, status: "done" }),
      recovery: createFakeRecovery(),
    });

    const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });

    expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
    expect(transaction.reopenIssue).toHaveBeenCalledTimes(1);
    expect(transaction.finalizePromotedWake).toHaveBeenCalledTimes(1);
    expect(result.outcome.kind).toBe("promoted");
  });

  it.each(["done_live", "cancelled_live", "done_missing", "done_self", "done_no_resume", "done_untracked_comment"])("handles explicit agent feedback after completion: %s", async (scenario) => {
    const commentIds = ["accepted-agent-feedback"];
    const queue = [wakeCandidate({
      agentId: ISSUE.assigneeAgentId!,
      requestedByActorType: "agent",
      requestedByActorId: "delegating-agent",
      queuedCommentIds: scenario === "done_untracked_comment" ? [] : commentIds,
      deferredCommentIds: commentIds,
      payload: { resumeIntent: scenario !== "done_no_resume", followUpRequested: true },
      deferredContextSeed: { resumeIntent: scenario !== "done_no_resume", followUpRequested: true, wakeCommentIds: commentIds },
    })];
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => queue.shift() ?? null),
      getQueuedCommentLiveness: vi.fn(async () => ({
        liveNonSelfCommentIds: scenario === "done_missing" || scenario === "done_self" ? [] : commentIds,
        containedSelfAuthoredComment: scenario === "done_self",
      })),
      getCommentSelfAuthorship: vi.fn(async () => ({ allSelfAuthored: scenario === "done_self" })),
      reopenIssue: vi.fn(async () => ({ ...ISSUE, status: "todo" })),
    });
    const release = createReleaseIssueExecution({
      issueLock: createFakeIssueLock(createFakeHost(), transaction, { ...ISSUE, status: scenario === "cancelled_live" ? "cancelled" : "done" }),
      recovery: createFakeRecovery(),
    });

    const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });

    if (scenario === "done_live") {
      expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
      expect(transaction.reopenIssue).toHaveBeenCalledTimes(1);
      expect(transaction.finalizePromotedWake).toHaveBeenCalledTimes(1);
      expect(result.outcome.kind).toBe("promoted");
    } else {
      expect(transaction.cancelDeferredWake).toHaveBeenCalledTimes(1);
      expect(transaction.reopenIssue).not.toHaveBeenCalled();
      expect(transaction.finalizePromotedWake).not.toHaveBeenCalled();
      expect(result.outcome.kind).toBe("released");
    }
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
    const findNextDeferredWake = vi.fn(async () => queue.shift() ?? null);
    const claimDeferredWakeForPromotion = vi.fn(async ({ wakeId }: { wakeId: string }) => wakeId !== "wake-lost-race");
    const reopenIssue = vi.fn(async () => null);
    const transaction = createFakeTransaction({ findNextDeferredWake, claimDeferredWakeForPromotion, reopenIssue });
    const host = createFakeHost();
    const issueLock: IssueLockWriter = {
      withIssueExecutionLock: vi.fn(async (_input, fn) => {
        const result = await fn({ primaryIssue: doneIssue, run: RUN }, { host, transaction });
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
    const transaction = createFakeTransaction({ findNextDeferredWake: vi.fn(async () => wakeCandidate()) });
    const host = createFakeHost({ resolveResponsibleUserId: vi.fn(async () => null) });
    const issueLock = createFakeIssueLock(host, transaction);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    await expect(
      releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() }),
    ).rejects.toMatchObject({
      constructor: WakeQueueApplicationError,
      code: "responsible_user_unresolved",
    });
  });

  it("resolves the responsible user for an immediate recovery run before queuing it", async () => {
    const resolveResponsibleUserId = vi.fn(
      async (_input: Parameters<WakeQueueHost["resolveResponsibleUserId"]>[0]) => "resolved-user",
    );
    const queueImmediateRecoveryRun = vi.fn(
      async (input: Parameters<WakeQueueTransaction["queueImmediateRecoveryRun"]>[0]) => runSummary("immediate-recovery"),
    );
    const transaction = createFakeTransaction({ queueImmediateRecoveryRun });
    const host = createFakeHost({ resolveResponsibleUserId });
    const issueLock = createFakeIssueLock(host, transaction);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(result.outcome.kind).toBe("queued_recovery");
    expect(resolveResponsibleUserId).toHaveBeenCalledTimes(1);
    const resolveCall = resolveResponsibleUserId.mock.calls[0]![0];
    expect(resolveCall.requestedByActorType).toBe("system");
    expect(resolveCall.requestedByActorId).toBeNull();
    expect(resolveCall.source).toBe("automation");
    expect(resolveCall.triggerDetail).toBe("system");
    expect(resolveCall.existingRunResponsibleUserId).toBe(RUN.responsibleUserId);
    // ISSUE.status is "in_progress", so the stalled-continuation labels apply.
    expect(resolveCall.contextSnapshot).toEqual({
      issueId: ISSUE.id,
      taskId: ISSUE.id,
      wakeReason: "issue_continuation_needed",
      retryReason: "issue_continuation_needed",
      source: "issue.continuation_recovery",
      retryOfRunId: RUN.id,
    });

    expect(queueImmediateRecoveryRun).toHaveBeenCalledTimes(1);
    const queueCall = queueImmediateRecoveryRun.mock.calls[0]![0];
    expect(queueCall.reason).toBe("issue_continuation_needed");
    expect(queueCall.responsibleUserId).toBe("resolved-user");
    expect(queueCall.contextSnapshot).toBe(resolveCall.contextSnapshot);
  });

  it.each([
    ["board cancel", { errorCode: "cancelled", operatorStopped: true }],
    ["agent pause", { errorCode: "agent_paused", operatorStopped: true }],
  ] as const)("does not re-queue or escalate a run a person stopped (%s)", async (_label, stop) => {
    // Regression: a board cancel of a queued wake re-created it as
    // issue_continuation_needed / issue_assignment_recovery within a second.
    for (const status of ["in_progress", "todo"]) {
      const transaction = createFakeTransaction();
      const recovery = createFakeRecovery();
      const release = createReleaseIssueExecution({
        issueLock: createFakeIssueLock(createFakeHost(), transaction, { ...ISSUE, status }, { ...RUN, status: "cancelled", ...stop }),
        recovery,
      });
      const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });
      expect(result.outcome.kind).toBe("released");
      expect(transaction.queueImmediateRecoveryRun).not.toHaveBeenCalled();
      expect(recovery.escalateStrandedAssignedIssue).not.toHaveBeenCalled();
    }
  });

  it("still recovers a control-plane cancelled run that no person stopped", async () => {
    const transaction = createFakeTransaction();
    const release = createReleaseIssueExecution({
      issueLock: createFakeIssueLock(createFakeHost(), transaction, ISSUE, { ...RUN, status: "cancelled", errorCode: "cancelled", operatorStopped: false }),
      recovery: createFakeRecovery(),
    });
    const result = await release({ companyId: RUN.companyId, runId: RUN.id, now: new Date() });
    expect(result.outcome.kind).toBe("queued_recovery");
    expect(transaction.queueImmediateRecoveryRun).toHaveBeenCalledTimes(1);
  });

  it("throws WakeQueueApplicationError with code responsible_user_unresolved for a recovery run, without queuing it", async () => {
    const transaction = createFakeTransaction();
    const host = createFakeHost({ resolveResponsibleUserId: vi.fn(async () => null) });
    const issueLock = createFakeIssueLock(host, transaction);
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery: createFakeRecovery() });

    await expect(
      releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() }),
    ).rejects.toMatchObject({
      constructor: WakeQueueApplicationError,
      code: "responsible_user_unresolved",
    });
    expect(transaction.queueImmediateRecoveryRun).not.toHaveBeenCalled();
  });

  it("escalates through the recovery port for a blocked outcome, after the transaction resolves", async () => {
    const transaction = createFakeTransaction({
      findNextDeferredWake: vi.fn(async () => null),
      hasExistingExecutionPath: vi.fn(async () => false),
      isAutomaticRecoverySuppressedByPauseHold: vi.fn(async () => false),
      // The recovery agent (the finishing run's own agent) is not invokable, which forces "blocked".
      findInvokableAgent: vi.fn(async () => null),
    });
    const host = createFakeHost();
    const issueLock = createFakeIssueLock(host, transaction);
    const recovery = createFakeRecovery();
    const releaseIssueExecution = createReleaseIssueExecution({ issueLock, recovery });

    const result = await releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date() });

    expect(result.outcome.kind).toBe("blocked");
    expect(result.outcome.kind === "blocked" && result.outcome.noticeKind).toBe("immediate_execution_path");
    expect(recovery.escalateStrandedAssignedIssue).toHaveBeenCalledTimes(1);
  });
});

const ACTIVE_EXECUTION_RUN: WakeAdmissionActiveExecutionRun = {
  id: "active-run-1",
  agentId: "execution-agent",
  status: "running",
  contextSnapshot: { taskKey: "issue-1" },
};

// The scope is opaque to the use case; the fakes below never inspect it.
const SCOPE = {} as TransactionScope;

function admissionInput(
  overrides: Partial<AdmitWakeBehindIssueExecutionInput> = {},
): AdmitWakeBehindIssueExecutionInput {
  return {
    companyId: "company-1",
    issueId: "issue-1",
    agentId: "wake-agent",
    agentNameKey: "codexcoder",
    issueExecutionAgentNameKey: null,
    activeExecutionRun: ACTIVE_EXECUTION_RUN,
    liveRunExecutions: { has: () => true },
    wakeCommentId: null,
    forceFreshSession: false,
    contextSnapshot: { wakeReason: "issue_commented" },
    source: "on_demand",
    triggerDetail: null,
    payload: { issueId: "issue-1" },
    requestedByActorType: "user",
    requestedByActorId: "user-1",
    idempotencyKey: null,
    ...overrides,
  };
}

function createFakeAdmissionReader(overrides: Partial<WakeAdmissionReader> = {}): WakeAdmissionReader {
  return {
    isSameExecutionAgent: vi.fn(async () => true),
    matchesActiveWakeActor: vi.fn(async () => true),
    findExistingDeferredWake: vi.fn(async () => null),
    ...overrides,
  };
}

function createFakeAdmissionWriter(overrides: Partial<WakeAdmissionWriter> = {}): WakeAdmissionWriter {
  return {
    coalesceIntoActiveExecutionRun: vi.fn(async () => ({ id: "merged-run-1" })),
    mergeIntoExistingDeferredWake: vi.fn(async () => {}),
    insertNewDeferredWake: vi.fn(async () => {}),
    ...overrides,
  };
}

// Test doubles for the four heartbeat.ts decision helpers the module
// receives as a port. The defaults mirror the real helpers' behaviour for
// the plain wake in `admissionInput()`: no comment id, no forced fresh
// session, and a live coalesce target when `liveRunExecutions.has` says so.
function createFakeAdmissionHelpers(
  overrides: Partial<WakeAdmissionHeartbeatHelpers> = {},
): WakeAdmissionHeartbeatHelpers {
  return {
    filterZombieCoalesceTarget: vi.fn((target, liveRunExecutions) =>
      target && liveRunExecutions.has(target.id) ? target : null,
    ),
    mergeCoalescedContextSnapshot: vi.fn((existingRaw, incoming) => ({
      ...(existingRaw && typeof existingRaw === "object" ? (existingRaw as Record<string, unknown>) : {}),
      ...incoming,
    })),
    shouldDeferFollowupWakeForSameIssue: vi.fn(() => false),
    shouldQueueFollowupForRunningIssueWake: vi.fn(() => false),
    ...overrides,
  };
}

// Reads a deferred wake row the way the Postgres adapter's toDeferredWakeCandidate
// does, with the same helpers, so the drain sees the flags a real row gives.
function asAdapterReads(row: Pick<DeferredWakeCandidate, "id" | "reason" | "source" | "requestedByActorType"> & {
  payload: Record<string, unknown>;
}): DeferredWakeCandidate {
  const seed = (row.payload._paperclipWakeContext ?? {}) as Record<string, unknown>;
  return wakeCandidate({
    ...row,
    queuedCommentIds: queuedCommentIdsFromWakePayload(row.payload),
    deferredContextSeed: seed,
    deferredCommentIds: extractWakeCommentIds(seed),
    wakeReason: typeof seed.wakeReason === "string" && seed.wakeReason ? seed.wakeReason : null,
    preservesIndependentContinuation: deferredWakePreservesIndependentContinuation({ rowReason: row.reason, deferredContextSeed: seed }),
  });
}

describe("releaseIssueExecution: execution-stage wake freshness under the issue lock", () => {
  const REVIEW_ISSUE: IssueSnapshot = {
    ...ISSUE,
    status: "in_review",
    assigneeAgentId: "deferred-agent",
    executionState: {
      status: "pending",
      currentStageId: "stage-current",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: "deferred-agent" },
      returnAssignee: { type: "agent", agentId: "finishing-agent" },
    },
  };

  function stageWake(id: string, stageId: string, extra: Record<string, unknown> = {}): DeferredWakeCandidate {
    const executionStage = { stageId, stageType: "review", wakeRole: "reviewer" };
    const seed = { issueId: "issue-1", wakeReason: "execution_review_requested", executionStage, ...extra };
    return asAdapterReads({
      id,
      reason: "issue_execution_deferred",
      source: "assignment",
      requestedByActorType: "agent",
      payload: { issueId: "issue-1", mutation: "update", executionStage, _paperclipWakeContext: seed },
    });
  }

  function drain(queue: DeferredWakeCandidate[], issue: IssueSnapshot, opts: { agentPaused?: boolean } = {}) {
    const byId = new Map(queue.map(wake => [wake.id, wake]));
    const findNextDeferredWake = vi.fn(async () => queue.shift() ?? null);
    // Rewrites the row like the adapter does and reads it back the same way.
    const normalizeDeferredWakeCommentIds = vi.fn(async (input: { wakeId: string; payload: Record<string, unknown>; liveCommentIds: string[] }) =>
      asAdapterReads({ ...byId.get(input.wakeId)!, payload: withQueuedCommentIdsInWakePayload(input.payload, input.liveCommentIds) }));
    const findInvokableAgent = vi.fn(async () => opts.agentPaused ? { ...AGENT, invokable: false, paused: true } : AGENT);
    const transaction = createFakeTransaction({ findNextDeferredWake, normalizeDeferredWakeCommentIds, findInvokableAgent });
    const host = createFakeHost();
    const releaseIssueExecution = createReleaseIssueExecution({
      issueLock: createFakeIssueLock(host, transaction, issue), recovery: createFakeRecovery(),
    });
    return { transaction, run: () => releaseIssueExecution({ companyId: "company-1", runId: "run-1", now: new Date(), resumeStrandedQueue: true }) };
  }

  it("cancels a stale stage wake queued ahead of a current one and promotes only the current one", async () => {
    const { transaction, run } = drain([stageWake("wake-stale", "stage-old"), stageWake("wake-current", "stage-current")], REVIEW_ISSUE);

    const result = await run();

    expect(transaction.cancelDeferredWake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      wakeId: "wake-stale", reason: "The stage or assignment this deferred wake was for has moved on",
    }));
    expect(transaction.claimDeferredWakeForPromotion).toHaveBeenCalledTimes(1);
    expect(transaction.claimDeferredWakeForPromotion).toHaveBeenCalledWith(expect.objectContaining({ wakeId: "wake-current" }));
    expect(result.outcome.kind).toBe("promoted");
    expect(result.postCommitEffects).toEqual([{ kind: "run_queued", run: runSummary("wake-current") }]);
  });

  it("uses the issue read under the lock when the stage moved after a scan picked the wake", async () => {
    // The scan saw stage-current; by the time the lock is held the stage has moved on.
    const moved: IssueSnapshot = { ...REVIEW_ISSUE, executionState: { ...(REVIEW_ISSUE.executionState as object), currentStageId: "stage-next" } };
    const { transaction, run } = drain([stageWake("wake-picked", "stage-current")], moved);

    const result = await run();

    expect(transaction.cancelDeferredWake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ wakeId: "wake-picked" }));
    expect(transaction.claimDeferredWakeForPromotion).not.toHaveBeenCalled();
    expect(result.postCommitEffects).not.toContainEqual(expect.objectContaining({ kind: "run_queued" }));
  });

  it("cancels a stage wake whose agent no longer owns the issue", async () => {
    const reassigned: IssueSnapshot = { ...REVIEW_ISSUE, assigneeAgentId: "other-agent" };
    const { transaction, run } = drain([stageWake("wake-reassigned", "stage-current")], reassigned);

    await run();

    expect(transaction.cancelDeferredWake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ wakeId: "wake-reassigned" }));
    expect(transaction.claimDeferredWakeForPromotion).not.toHaveBeenCalled();
  });

  function promotedContext(transaction: WakeQueueTransaction) {
    const call = vi.mocked(transaction.finalizePromotedWake).mock.calls[0]![0];
    return { context: call.contextSnapshot, payload: call.payload };
  }

  it("delivers the queued comments of a mixed wake but not its stale stage", async () => {
    const mixed = { ...stageWake("wake-mixed", "stage-old", { wakeCommentIds: ["c1"] }), queuedCommentIds: ["c1"], deferredCommentIds: ["c1"] };
    const { transaction, run } = drain([mixed], REVIEW_ISSUE);
    vi.mocked(transaction.getQueuedCommentLiveness).mockResolvedValue({ liveNonSelfCommentIds: ["c1"], containedSelfAuthoredComment: false });

    await run();

    expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
    expect(transaction.claimDeferredWakeForPromotion).toHaveBeenCalledWith(expect.objectContaining({ wakeId: "wake-mixed" }));
    const { context, payload } = promotedContext(transaction);
    expect(context).not.toHaveProperty("executionStage");
    expect(payload).not.toHaveProperty("executionStage");
    expect(context).toMatchObject({ wakeReason: "issue_commented", wakeCommentIds: ["c1"] });
  });

  it("keeps the stage of a mixed wake whose stage is still current", async () => {
    const mixed = { ...stageWake("wake-mixed-current", "stage-current", { wakeCommentIds: ["c1"] }), queuedCommentIds: ["c1"], deferredCommentIds: ["c1"] };
    const { transaction, run } = drain([mixed], REVIEW_ISSUE);
    vi.mocked(transaction.getQueuedCommentLiveness).mockResolvedValue({ liveNonSelfCommentIds: ["c1"], containedSelfAuthoredComment: false });

    await run();

    const { context } = promotedContext(transaction);
    expect(context).toMatchObject({ wakeReason: "execution_review_requested", executionStage: { stageId: "stage-current" } });
  });

  it("delivers an interaction carried with a stale stage, without the stage", async () => {
    const base = stageWake("wake-interaction", "stage-old", { interactionId: "interaction-1", interactionKind: "ask_user_questions" });
    const mixed = { ...base, payload: { ...base.payload, mutation: "interaction" } };
    const { transaction, run } = drain([mixed], REVIEW_ISSUE);

    await run();

    expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
    const { context } = promotedContext(transaction);
    expect(context).not.toHaveProperty("executionStage");
    expect(context.wakeReason).not.toBe("execution_review_requested");
    expect(context).toMatchObject({ interactionId: "interaction-1" });
  });

  it("cancels a mixed wake with a stale stage once its queued comments are gone", async () => {
    const mixed = { ...stageWake("wake-mixed-empty", "stage-old", { wakeCommentIds: ["c1"] }), queuedCommentIds: ["c1"], deferredCommentIds: ["c1"] };
    const { transaction, run } = drain([mixed], REVIEW_ISSUE);
    vi.mocked(transaction.normalizeDeferredWakeCommentIds).mockImplementation(async (input) => {
      const seed = { ...(mixed.deferredContextSeed as Record<string, unknown>), wakeCommentIds: input.liveCommentIds };
      return { ...mixed, queuedCommentIds: input.liveCommentIds, deferredCommentIds: input.liveCommentIds,
        deferredContextSeed: seed, payload: { ...mixed.payload, _paperclipWakeContext: seed } };
    });

    await run();

    expect(transaction.normalizeDeferredWakeCommentIds).toHaveBeenCalledWith(expect.objectContaining({ liveCommentIds: [] }));
    expect(transaction.cancelDeferredWake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      wakeId: "wake-mixed-empty", reason: "The stage or assignment this deferred wake was for has moved on",
    }));
    expect(transaction.claimDeferredWakeForPromotion).not.toHaveBeenCalled();
  });

  function livenessWake(id: string, extraSeed: Record<string, unknown> = {}): DeferredWakeCandidate {
    const seed = { issueId: "issue-1", wakeReason: "run_liveness_continuation", livenessContinuationSourceRunId: "run-0",
      livenessContinuationAttempt: 1, ...extraSeed };
    const payload = { issueId: "issue-1", sourceRunId: "run-0", livenessState: "plan_only", continuationAttempt: 1,
      instruction: "Take the next step.", _paperclipWakeContext: seed };
    return asAdapterReads({ id, reason: "run_liveness_continuation", source: "automation", requestedByActorType: "system", payload });
  }
  const OPEN_ISSUE: IssueSnapshot = { ...REVIEW_ISSUE, status: "in_progress", assigneeAgentId: "deferred-agent", executionState: null };

  // System continuations are out of scope: the drain does not judge them,
  // as on master. A liveness continuation is promoted whatever the issue state.
  it.each([
    ["open, owned, with no execution policy state", OPEN_ISSUE],
    ["blocked", { ...OPEN_ISSUE, status: "blocked" }],
    ["under an execution policy state", { ...OPEN_ISSUE, executionState: REVIEW_ISSUE.executionState }],
  ])("does not judge a run liveness continuation when the issue is %s", async (_label, issue) => {
    const { transaction, run } = drain([livenessWake("wake-liveness")], issue as IssueSnapshot);

    await run();

    expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
    expect(promotedContext(transaction).context).toMatchObject({ wakeReason: "run_liveness_continuation", livenessContinuationSourceRunId: "run-0" });
  });

  it("keeps a liveness continuation merged with a live comment, whatever the issue state", async () => {
    const merged = livenessWake("wake-liveness-comment", { wakeReason: "issue_commented", wakeCommentIds: ["c1"] });
    const { transaction, run } = drain([merged], { ...OPEN_ISSUE, status: "blocked" });
    vi.mocked(transaction.getQueuedCommentLiveness).mockResolvedValue({ liveNonSelfCommentIds: ["c1"], containedSelfAuthoredComment: false });

    await run();

    const { context, payload } = promotedContext(transaction);
    expect(context).toMatchObject({ wakeReason: "issue_commented", wakeCommentIds: ["c1"], livenessContinuationSourceRunId: "run-0" });
    expect(payload).toMatchObject({ instruction: "Take the next step." });
  });

  it("leaves other system continuations to the existing handling", async () => {
    const seed = { issueId: "issue-1", wakeReason: "issue_continuation_needed" };
    const continuation = asAdapterReads({ id: "wake-continuation", reason: "issue_execution_deferred", source: "automation",
      requestedByActorType: "system", payload: { issueId: "issue-1", _paperclipWakeContext: seed } });
    const { transaction, run } = drain([continuation], { ...OPEN_ISSUE, status: "blocked" });

    await run();

    expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
    expect(transaction.claimDeferredWakeForPromotion).toHaveBeenCalledWith(expect.objectContaining({ wakeId: "wake-continuation" }));
  });

  // Merge two wakes through the real admission use case and the real context
  // merge, read the merged row the way the adapter does, then drain it.
  describe("merged into one deferred wake, then drained under the lock", () => {
    const STAGE_OLD = { stageId: "stage-old", stageType: "review", wakeRole: "reviewer" };
    const STAGE_CURRENT = { stageId: "stage-current", stageType: "review", wakeRole: "reviewer" };
    type Arrival = {
      source: "assignment" | "automation"; triggerDetail: "system" | null;
      payload: Record<string, unknown>; contextSnapshot: Record<string, unknown>;
    };
    const stageArrival = (stage: Record<string, unknown>): Arrival => ({
      source: "assignment", triggerDetail: "system",
      payload: { issueId: "issue-1", mutation: "update", executionStage: stage },
      contextSnapshot: { issueId: "issue-1", wakeReason: "execution_review_requested", source: "issue.execution_stage", executionStage: stage },
    });
    const livenessArrival: Arrival = {
      source: "automation", triggerDetail: "system",
      payload: { issueId: "issue-1", sourceRunId: "run-0", livenessState: "plan_only", continuationAttempt: 1, instruction: "Take the next step." },
      contextSnapshot: { issueId: "issue-1", wakeReason: "run_liveness_continuation", livenessContinuationSourceRunId: "run-0",
        livenessContinuationAttempt: 1 },
    };
    const commentArrival: Arrival = {
      source: "automation", triggerDetail: null,
      payload: { issueId: "issue-1", commentId: "c1", mutation: "comment" },
      contextSnapshot: { issueId: "issue-1", wakeReason: "issue_commented", source: "issue.comment", commentId: "c1", wakeCommentIds: ["c1"] },
    };
    // What the comment-liveness read reports for the queued comment.
    const COMMENT: Record<"live" | "deleted" | "delivered",
      { liveNonSelfCommentIds: string[]; containedSelfAuthoredComment: boolean; deliveredCommentIds?: string[] }> = {
      live: { liveNonSelfCommentIds: ["c1"], containedSelfAuthoredComment: false },
      deleted: { liveNonSelfCommentIds: [], containedSelfAuthoredComment: false },
      delivered: { liveNonSelfCommentIds: [], containedSelfAuthoredComment: false, deliveredCommentIds: ["c1"] },
    };
    const LIVENESS_ISSUE: IssueSnapshot = { ...REVIEW_ISSUE, status: "in_progress", executionState: null };

    async function mergeThenDrain(first: Arrival, second: Arrival, opts: { issue?: IssueSnapshot; comment?: keyof typeof COMMENT } = {}) {
      const writer = createFakeAdmissionWriter();
      const admit = createAdmitWakeBehindIssueExecution({
        reader: createFakeAdmissionReader({
          isSameExecutionAgent: vi.fn(async () => false),
          findExistingDeferredWake: vi.fn(async () => ({
            id: "wake-merged", payload: { ...first.payload, _paperclipWakeContext: first.contextSnapshot },
            deferredContext: first.contextSnapshot, coalescedCount: 0,
          })),
        }),
        writer,
        // The real merge helper the heartbeat service passes in.
        helpers: createFakeAdmissionHelpers({ mergeCoalescedContextSnapshot }),
      });
      await admit(SCOPE, admissionInput({ agentId: "deferred-agent", source: second.source, triggerDetail: second.triggerDetail,
        payload: second.payload, contextSnapshot: second.contextSnapshot,
        requestedByActorType: "agent", requestedByActorId: "finishing-agent" }));
      expect(writer.mergeIntoExistingDeferredWake).toHaveBeenCalledOnce();
      const mergedPayload = vi.mocked(writer.mergeIntoExistingDeferredWake).mock.calls[0]![1].mergedPayload as Record<string, unknown>;
      const mergedSeed = mergedPayload._paperclipWakeContext as Record<string, unknown>;
      // The row keeps the first wake's source.
      const candidate = asAdapterReads({ id: "wake-merged", reason: "issue_execution_deferred", source: first.source,
        requestedByActorType: "agent", payload: mergedPayload });
      const drained = drain([candidate], opts.issue ?? REVIEW_ISSUE);
      vi.mocked(drained.transaction.getQueuedCommentLiveness).mockResolvedValue(COMMENT[opts.comment ?? "live"]);
      await drained.run();
      return { transaction: drained.transaction, mergedSeed, candidate };
    }

    const bothOrders = (work: () => Arrival) => [
      ["work first, comment second", () => [work(), commentArrival] as const],
      ["comment first, work second", () => [commentArrival, work()] as const],
    ] as const;

    it.each(bothOrders(() => stageArrival(STAGE_OLD)))("drops a stale stage and keeps a live comment (%s)", async (_label, order) => {
      const [first, second] = order();
      const { transaction, mergedSeed } = await mergeThenDrain(first, second);

      expect(mergedSeed).toMatchObject({ executionStage: STAGE_OLD, wakeCommentIds: ["c1"] });
      expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
      const { context, payload } = promotedContext(transaction);
      expect(context).not.toHaveProperty("executionStage");
      expect(payload).not.toHaveProperty("executionStage");
      expect(context).toMatchObject({ wakeReason: "issue_commented", wakeCommentIds: ["c1"] });
    });

    it.each(bothOrders(() => stageArrival(STAGE_CURRENT)))("keeps a current stage and a live comment (%s)", async (_label, order) => {
      const [first, second] = order();
      const { transaction } = await mergeThenDrain(first, second);

      expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
      const { context } = promotedContext(transaction);
      expect(context).toMatchObject({ executionStage: STAGE_CURRENT, wakeCommentIds: ["c1"] });
    });

    describe.each(["deleted", "delivered"] as const)("once the comment is %s", (comment) => {
      it.each(bothOrders(() => stageArrival(STAGE_CURRENT)))("still promotes the current stage, under its own reason (%s)", async (_label, order) => {
        const [first, second] = order();
        const { transaction, candidate } = await mergeThenDrain(first, second, { comment });

        if (first === commentArrival) expect(candidate.preservesIndependentContinuation).toBe(true);
        else expect(candidate.preservesIndependentContinuation).toBe(false); // the row reads as a comment wake
        expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
        expect(transaction.claimDeferredWakeForPromotion).toHaveBeenCalledWith(expect.objectContaining({ wakeId: "wake-merged" }));
        const { context } = promotedContext(transaction);
        expect(context).toMatchObject({ executionStage: STAGE_CURRENT, wakeReason: "execution_review_requested", source: "issue.execution_stage" });
        expect(context).not.toHaveProperty("wakeCommentIds");
      });

      it.each(bothOrders(() => stageArrival(STAGE_OLD)))("cancels the stale stage, with nothing left to deliver (%s)", async (_label, order) => {
        const [first, second] = order();
        const { transaction } = await mergeThenDrain(first, second, { comment });

        expect(transaction.cancelDeferredWake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ wakeId: "wake-merged" }));
        expect(transaction.claimDeferredWakeForPromotion).not.toHaveBeenCalled();
      });

      // Not judged (out of scope), but independent work: the dead comment
      // does not take it down, whichever wake was merged last.
      it.each(bothOrders(() => livenessArrival))("still promotes a carried liveness continuation, under its own reason (%s)", async (_label, order) => {
        const [first, second] = order();
        for (const issue of [LIVENESS_ISSUE, { ...LIVENESS_ISSUE, status: "blocked" }]) {
          const { transaction } = await mergeThenDrain(first, second, { issue, comment });

          expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
          const { context, payload } = promotedContext(transaction);
          expect(context).toMatchObject({ wakeReason: "run_liveness_continuation", livenessContinuationSourceRunId: "run-0" });
          expect(context).not.toHaveProperty("wakeCommentIds");
          // The restored reason drops the comment source; with the comment first,
          // the merge already gave the continuation reason and the drain leaves it.
          if (first === livenessArrival) expect(context).not.toHaveProperty("source");
          expect(payload).toMatchObject({ instruction: "Take the next step." });
        }
      });
    });

    it.each(bothOrders(() => livenessArrival))("keeps a liveness continuation and a live comment, whatever the issue state (%s)", async (_label, order) => {
      const [first, second] = order();
      for (const issue of [LIVENESS_ISSUE, { ...LIVENESS_ISSUE, status: "blocked" }]) {
        const { transaction } = await mergeThenDrain(first, second, { issue });

        expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
        const { context } = promotedContext(transaction);
        expect(context).toMatchObject({ livenessContinuationSourceRunId: "run-0", wakeCommentIds: ["c1"] });
      }
    });

    // The scan's selection of a deferred wake, as parkedExecutionWakePayloadSql
    // and the queued-comment and interaction branches beside it read the row.
    function strandedScanSelects(payload: Record<string, unknown>) {
      const seed = (payload._paperclipWakeContext ?? {}) as Record<string, unknown>;
      const comments = Array.isArray(seed.wakeCommentIds) ? seed.wakeCommentIds : [];
      if (comments.length > 0 || payload.mutation === "interaction") return true;
      const stage = (payload.executionStage ?? seed.executionStage ?? {}) as Record<string, unknown>;
      return (EXECUTION_STAGE_WAKE_REASONS as readonly unknown[]).includes(seed.wakeReason) && typeof stage.stageId === "string" &&
        seed.resumeIntent !== true && !hasInteractionContinuationWakeContext(seed);
    }

    // The agent is paused when the lock holder finishes: the drain keeps the
    // wake deferred. What it stores must bring the wake back once the agent
    // resumes, with only the work that is still due.
    describe("kept deferred for a paused agent, then drained again", () => {
      async function pauseThenResume(first: Arrival, second: Arrival, comment: keyof typeof COMMENT, issue = REVIEW_ISSUE) {
        const writer = createFakeAdmissionWriter();
        const admit = createAdmitWakeBehindIssueExecution({
          reader: createFakeAdmissionReader({
            isSameExecutionAgent: vi.fn(async () => false),
            findExistingDeferredWake: vi.fn(async () => ({
              id: "wake-merged", payload: { ...first.payload, _paperclipWakeContext: first.contextSnapshot },
              deferredContext: first.contextSnapshot, coalescedCount: 0,
            })),
          }),
          writer,
          helpers: createFakeAdmissionHelpers({ mergeCoalescedContextSnapshot }),
        });
        await admit(SCOPE, admissionInput({ agentId: "deferred-agent", source: second.source, triggerDetail: second.triggerDetail,
          payload: second.payload, contextSnapshot: second.contextSnapshot,
          requestedByActorType: "agent", requestedByActorId: "finishing-agent" }));
        const mergedPayload = vi.mocked(writer.mergeIntoExistingDeferredWake).mock.calls[0]![1].mergedPayload as Record<string, unknown>;
        const row = (payload: Record<string, unknown>) => asAdapterReads({ id: "wake-merged", reason: "issue_execution_deferred",
          source: first.source, requestedByActorType: "agent", payload });

        const paused = drain([row(mergedPayload)], issue, { agentPaused: true });
        vi.mocked(paused.transaction.getQueuedCommentLiveness).mockResolvedValue(COMMENT[comment]);
        const pausedResult = await paused.run();
        // Every write to the row, in order; the last one is what stays stored.
        const writes = vi.mocked(paused.transaction.normalizeDeferredWakeCommentIds).mock.calls.map(([input]) =>
          withQueuedCommentIdsInWakePayload(input.payload, input.liveCommentIds));
        const stored = writes.at(-1) ?? mergedPayload;

        const resumed = drain([row(stored)], issue);
        vi.mocked(resumed.transaction.getQueuedCommentLiveness).mockResolvedValue(COMMENT[comment]);
        await resumed.run();
        return { paused: paused.transaction, pausedResult, stored, resumed: resumed.transaction };
      }

      describe.each(["deleted", "delivered"] as const)("once the comment is %s", (comment) => {
        it.each(bothOrders(() => stageArrival(STAGE_CURRENT)))("stores the current stage under its own reason and promotes it on resume (%s)", async (_label, order) => {
          const [first, second] = order();
          const { paused, pausedResult, stored, resumed } = await pauseThenResume(first, second, comment);

          expect(pausedResult.outcome.kind).not.toBe("promoted");
          expect(paused.cancelDeferredWake).not.toHaveBeenCalled();
          expect(paused.claimDeferredWakeForPromotion).not.toHaveBeenCalled();
          const seed = stored._paperclipWakeContext as Record<string, unknown>;
          expect(seed).toMatchObject({ wakeReason: "execution_review_requested", executionStage: STAGE_CURRENT, source: "issue.execution_stage" });
          expect(seed).not.toHaveProperty("wakeCommentIds");
          expect(strandedScanSelects(stored)).toBe(true);

          expect(resumed.cancelDeferredWake).not.toHaveBeenCalled();
          expect(resumed.claimDeferredWakeForPromotion).toHaveBeenCalledWith(expect.objectContaining({ wakeId: "wake-merged" }));
          expect(promotedContext(resumed).context).toMatchObject({ executionStage: STAGE_CURRENT, wakeReason: "execution_review_requested" });
        });

        it.each(bothOrders(() => stageArrival(STAGE_OLD)))("cancels a stale stage instead of keeping it (%s)", async (_label, order) => {
          const [first, second] = order();
          const { paused } = await pauseThenResume(first, second, comment);

          expect(paused.cancelDeferredWake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ wakeId: "wake-merged" }));
          expect(paused.claimDeferredWakeForPromotion).not.toHaveBeenCalled();
        });
      });

      it.each(bothOrders(() => stageArrival(STAGE_OLD)))("stores a live comment without the stale stage and delivers it on resume (%s)", async (_label, order) => {
        const [first, second] = order();
        const { paused, stored, resumed } = await pauseThenResume(first, second, "live");

        expect(paused.cancelDeferredWake).not.toHaveBeenCalled();
        const seed = stored._paperclipWakeContext as Record<string, unknown>;
        expect(seed).not.toHaveProperty("executionStage");
        expect(stored).not.toHaveProperty("executionStage");
        expect(seed).toMatchObject({ wakeReason: "issue_commented", wakeCommentIds: ["c1"] });
        expect(strandedScanSelects(stored)).toBe(true);

        const { context } = promotedContext(resumed);
        expect(context).not.toHaveProperty("executionStage");
        expect(context).toMatchObject({ wakeReason: "issue_commented", wakeCommentIds: ["c1"] });
      });

      it.each(bothOrders(() => stageArrival(STAGE_CURRENT)))("does not rewrite a wake whose context needs no change (%s)", async (_label, order) => {
        const [first, second] = order();
        const { paused, resumed } = await pauseThenResume(first, second, "live");

        expect(paused.normalizeDeferredWakeCommentIds).not.toHaveBeenCalled();
        expect(promotedContext(resumed).context).toMatchObject({ executionStage: STAGE_CURRENT, wakeCommentIds: ["c1"] });
      });
    });
  });

  it("does not touch ordinary comment wakes", async () => {
    const { transaction, run } = drain([wakeCandidate({ id: "wake-plain", queuedCommentIds: ["c1"] })], REVIEW_ISSUE);
    vi.mocked(transaction.getQueuedCommentLiveness).mockResolvedValue({ liveNonSelfCommentIds: ["c1"], containedSelfAuthoredComment: false });

    await run();

    expect(transaction.cancelDeferredWake).not.toHaveBeenCalled();
    expect(transaction.claimDeferredWakeForPromotion).toHaveBeenCalledWith(expect.objectContaining({ wakeId: "wake-plain" }));
  });
});

describe("admitWakeBehindIssueExecution", () => {
  it.each(["running", "queued"])(
    "keeps a dedicated durable continuation separate from a %s execution and an existing deferred wake",
    async (status) => {
      const durableReceipt = {
        id: "dedicated-receipt",
        requestedAt: new Date("2026-09-10T00:00:00Z"),
      };
      const writer = createFakeAdmissionWriter();
      const reader = createFakeAdmissionReader({
        findExistingDeferredWake: vi.fn(async () => ({
          id: "unrelated-deferred-wake",
          payload: {},
          deferredContext: {},
          coalescedCount: 0,
        })),
      });
      const helpers = createFakeAdmissionHelpers();
      const admit = createAdmitWakeBehindIssueExecution({
        reader,
        writer,
        helpers,
      });
      const contextSnapshot = {
        issueId: "issue-1",
        externalChatContinuation: true,
        interactionId: "exact-interaction",
        sourceRunId: "exact-source-run",
      };

      const result = await admit(
        SCOPE,
        admissionInput({
          activeExecutionRun: { ...ACTIVE_EXECUTION_RUN, status },
          allowRunCoalescing: false,
          durableReceipt,
          contextSnapshot,
        }),
      );

      expect(result).toEqual({ kind: "deferred" });
      expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
      expect(reader.findExistingDeferredWake).not.toHaveBeenCalled();
      expect(writer.mergeIntoExistingDeferredWake).not.toHaveBeenCalled();
      expect(writer.insertNewDeferredWake).toHaveBeenCalledExactlyOnceWith(
        SCOPE,
        expect.objectContaining({
          durableReceipt,
          payload: {
            issueId: "issue-1",
            _paperclipWakeContext: contextSnapshot,
          },
        }),
      );
    },
  );

  it.each(["incoming", "queued", "deferred"])("does not coalesce a %s interaction with comments", async (location) => {
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader({
      isSameExecutionAgent: vi.fn(async () => location !== "deferred"),
      findExistingDeferredWake: vi.fn(async () => location === "deferred" ? {
        id: "existing", payload: { interactionId: "approval" },
        deferredContext: {}, coalescedCount: 0,
      } : null),
    });
    const admit = createAdmitWakeBehindIssueExecution({ reader, writer, helpers: createFakeAdmissionHelpers() });
    await admit(SCOPE, admissionInput({
      contextSnapshot: location === "incoming" ? { interactionId: "approval" } : {},
      activeExecutionRun: { ...ACTIVE_EXECUTION_RUN, status: "queued",
        contextSnapshot: location === "queued" ? { interactionId: "approval" } : {} },
    }));
    expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
    expect(writer.mergeIntoExistingDeferredWake).not.toHaveBeenCalled();
    expect(writer.insertNewDeferredWake).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "another conversation's queued run", active: "conversation-a", incoming: "conversation-b", coalesces: false },
    { label: "the same conversation's queued run", active: "conversation-a", incoming: "conversation-a", coalesces: true },
    { label: "a queued run without a conversation", active: undefined, incoming: "conversation-b", coalesces: true },
    { label: "a conversation's queued run from a non-chat wake", active: "conversation-a", incoming: undefined, coalesces: true },
  ])("coalesces a chat reply into $label only when one conversation is attested", async ({ active, incoming, coalesces }) => {
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader();
    const admit = createAdmitWakeBehindIssueExecution({ reader, writer, helpers: createFakeAdmissionHelpers() });
    await admit(SCOPE, admissionInput({
      contextSnapshot: incoming ? { chatConversationId: incoming } : {},
      activeExecutionRun: { ...ACTIVE_EXECUTION_RUN, status: "queued",
        contextSnapshot: active ? { chatConversationId: active } : {} },
    }));
    expect(writer.coalesceIntoActiveExecutionRun).toHaveBeenCalledTimes(coalesces ? 1 : 0);
    if (!coalesces) {
      // The separated reply still merges with its own conversation's deferred wake.
      expect(reader.findExistingDeferredWake).toHaveBeenCalledExactlyOnceWith(SCOPE,
        expect.objectContaining({ chatConversationId: incoming }));
      expect(writer.insertNewDeferredWake).toHaveBeenCalledOnce();
    }
  });

  it("partitions durable admission by the exact actor before considering a deferred merge", async () => {
    const durableReceipt = {
      id: "other-actor-receipt",
      requestedAt: new Date("2026-09-10T00:00:00Z"),
    };
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader({
      matchesActiveWakeActor: vi.fn(async () => false),
    });
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({
      reader,
      writer,
      helpers,
    });

    const result = await admit(
      SCOPE,
      admissionInput({
        activeExecutionRun: {
          ...ACTIVE_EXECUTION_RUN,
          wakeupRequestId: "active-wake",
        },
        durableReceipt,
        requestedByActorType: "user",
        requestedByActorId: "other-user",
      }),
    );

    expect(result).toEqual({ kind: "deferred" });
    expect(reader.matchesActiveWakeActor).toHaveBeenCalledExactlyOnceWith(
      SCOPE,
      {
        companyId: "company-1",
        wakeupRequestId: "active-wake",
        requestedByActorType: "user",
        requestedByActorId: "other-user",
      },
    );
    expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
    expect(reader.findExistingDeferredWake).toHaveBeenCalledExactlyOnceWith(
      SCOPE,
      {
        companyId: "company-1",
        agentId: "wake-agent",
        issueId: "issue-1",
        chatConversationId: null,
        durableActor: { type: "user", id: "other-user" },
      },
    );
    expect(writer.insertNewDeferredWake).toHaveBeenCalledExactlyOnceWith(
      SCOPE,
      expect.objectContaining({ durableReceipt }),
    );
  });

  it("retains the durable receipt when the exact actor coalesces into the active execution", async () => {
    const durableReceipt = {
      id: "coalesced-receipt",
      requestedAt: new Date("2026-09-10T00:00:00Z"),
    };
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader();
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({
      reader,
      writer,
      helpers,
    });

    const result = await admit(
      SCOPE,
      admissionInput({
        activeExecutionRun: {
          ...ACTIVE_EXECUTION_RUN,
          wakeupRequestId: "active-wake",
        },
        durableReceipt,
      }),
    );

    expect(result).toEqual({ kind: "coalesced", run: { id: "merged-run-1" } });
    expect(reader.matchesActiveWakeActor).toHaveBeenCalledExactlyOnceWith(
      SCOPE,
      {
        companyId: "company-1",
        wakeupRequestId: "active-wake",
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      },
    );
    expect(
      writer.coalesceIntoActiveExecutionRun,
    ).toHaveBeenCalledExactlyOnceWith(
      SCOPE,
      expect.objectContaining({ durableReceipt }),
    );
    expect(reader.findExistingDeferredWake).not.toHaveBeenCalled();
  });

  it("retains an independent receipt when durable input merges into an existing deferred wake", async () => {
    const durableReceipt = {
      id: "merged-deferred-receipt",
      requestedAt: new Date("2026-09-10T00:00:00Z"),
    };
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader({
      isSameExecutionAgent: vi.fn(async () => false),
      findExistingDeferredWake: vi.fn(async () => ({
        id: "existing-deferred-wake",
        runId: "existing-deferred-run",
        payload: { issueId: "issue-1", preserved: true },
        deferredContext: { preservedContext: true },
        coalescedCount: 2,
      })),
    });
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({
      reader,
      writer,
      helpers,
    });

    const result = await admit(
      SCOPE,
      admissionInput({
        durableReceipt,
        reason: "question_response",
        idempotencyKey: "exact-receipt-key",
      }),
    );

    expect(result).toEqual({ kind: "deferred" });
    expect(
      writer.mergeIntoExistingDeferredWake,
    ).toHaveBeenCalledExactlyOnceWith(
      SCOPE,
      expect.objectContaining({
        existingDeferredWakeId: "existing-deferred-wake",
        nextCoalescedCount: 3,
        mergedPayload: {
          issueId: "issue-1",
          preserved: true,
          _paperclipWakeContext: {
            preservedContext: true,
            wakeReason: "issue_commented",
          },
        },
        coalescedReceipt: {
          ...durableReceipt,
          agentId: "wake-agent",
          source: "on_demand",
          triggerDetail: null,
          reason: "question_response",
          payload: {
            issueId: "issue-1",
            coalescedIntoWakeupRequestId: "existing-deferred-wake",
          },
          requestedByActorType: "user",
          requestedByActorId: "user-1",
          idempotencyKey: "exact-receipt-key",
          runId: "existing-deferred-run",
        },
      }),
    );
    expect(writer.insertNewDeferredWake).not.toHaveBeenCalled();
    expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
  });

  it("records an ordinary merged comment under its own actor without requiring durable receipt identity", async () => {
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader({ findExistingDeferredWake: vi.fn(async () => ({
      id: "existing-deferred-wake", runId: null, payload: { issueId: "issue-1" }, deferredContext: {}, coalescedCount: 1,
    })) });
    const admit = createAdmitWakeBehindIssueExecution({ reader, writer,
      helpers: createFakeAdmissionHelpers({ shouldDeferFollowupWakeForSameIssue: vi.fn(() => true) }) });
    await expect(admit(SCOPE, admissionInput({ wakeCommentId: "second-comment", requestedByActorId: "second-user",
      payload: { commentId: "second-comment", coalescedIntoWakeupRequestId: "forged-target" },
    }))).resolves.toEqual({ kind: "deferred" });
    const input = vi.mocked(writer.mergeIntoExistingDeferredWake).mock.calls[0][1];
    expect(input.coalescedReceipt).toEqual({ agentId: "wake-agent", source: "on_demand", triggerDetail: null,
      reason: null, payload: { issueId: "issue-1", commentId: "second-comment", coalescedIntoWakeupRequestId: "existing-deferred-wake" },
      requestedByActorType: "user", requestedByActorId: "second-user", idempotencyKey: null, runId: null });
    expect(input.coalescedReceipt).not.toHaveProperty("id");
    expect(input.coalescedReceipt).not.toHaveProperty("requestedAt");
    expect(reader.matchesActiveWakeActor).not.toHaveBeenCalled();
  });

  it("binds authoritative issue scope when durable merged input omits it from payload", async () => {
    const writer = createFakeAdmissionWriter();
    const durableReceipt = { id: "own-request", requestedAt: new Date("2026-09-10T00:00:00Z") };
    const admit = createAdmitWakeBehindIssueExecution({ writer,
      reader: createFakeAdmissionReader({ findExistingDeferredWake: vi.fn(async () => ({
        id: "saved-wake", runId: null, payload: { issueId: "issue-1" }, deferredContext: {}, coalescedCount: 0,
      })) }), helpers: createFakeAdmissionHelpers({ shouldDeferFollowupWakeForSameIssue: vi.fn(() => true) }) });
    await admit(SCOPE, admissionInput({ durableReceipt, payload: { text: "saved input" } }));
    expect(vi.mocked(writer.mergeIntoExistingDeferredWake).mock.calls[0][1].coalescedReceipt).toEqual(expect.objectContaining({
      ...durableReceipt, payload: { text: "saved input", issueId: "issue-1", coalescedIntoWakeupRequestId: "saved-wake" },
    }));
  });

  it.each(["agent", "system"])("does not create a user-comment authority receipt for an ordinary %s merge", async actor => {
    const writer = createFakeAdmissionWriter();
    const admit = createAdmitWakeBehindIssueExecution({ writer,
      reader: createFakeAdmissionReader({ findExistingDeferredWake: vi.fn(async () => ({
        id: "existing-deferred-wake", runId: null, payload: { issueId: "issue-1" }, deferredContext: {}, coalescedCount: 1,
      })) }), helpers: createFakeAdmissionHelpers({ shouldDeferFollowupWakeForSameIssue: vi.fn(() => true) }) });
    await admit(SCOPE, admissionInput({ wakeCommentId: "second-comment", requestedByActorType: actor }));
    expect(vi.mocked(writer.mergeIntoExistingDeferredWake).mock.calls[0][1]).not.toHaveProperty("coalescedReceipt");
  });

  it("gives manual input its own run boundary even when the active receipt has the same requester", async () => {
    const writer = createFakeAdmissionWriter();
    const admit = createAdmitWakeBehindIssueExecution({
      reader: createFakeAdmissionReader(), writer, helpers: createFakeAdmissionHelpers(),
    });
    expect(await admit(SCOPE, admissionInput({ payload: { issueId: "issue-1", manualUserWake: true } })))
      .toEqual({ kind: "deferred" });
    expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
    expect(writer.insertNewDeferredWake).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary non-durable coalescing independent of durable actor lookup", async () => {
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader({
      matchesActiveWakeActor: vi.fn(async () => false),
    });
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({
      reader,
      writer,
      helpers,
    });

    expect(await admit(SCOPE, admissionInput())).toEqual({
      kind: "coalesced",
      run: { id: "merged-run-1" },
    });
    expect(reader.matchesActiveWakeActor).not.toHaveBeenCalled();
    expect(writer.coalesceIntoActiveExecutionRun).toHaveBeenCalledTimes(1);
  });

  it("returns the coalesce outcome and calls the writer one time when the same agent's run absorbs the wake", async () => {
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader();
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({ reader, writer, helpers });

    const result = await admit(SCOPE, admissionInput());

    expect(result).toEqual({ kind: "coalesced", run: { id: "merged-run-1" } });
    expect(writer.coalesceIntoActiveExecutionRun).toHaveBeenCalledTimes(1);
    expect(writer.mergeIntoExistingDeferredWake).not.toHaveBeenCalled();
    expect(writer.insertNewDeferredWake).not.toHaveBeenCalled();
  });

  it("never reads for an existing deferred wake on the coalesce path", async () => {
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader();
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({ reader, writer, helpers });

    const result = await admit(SCOPE, admissionInput());

    expect(result.kind).toBe("coalesced");
    expect(reader.findExistingDeferredWake).not.toHaveBeenCalled();
  });

  it("retains incoming receipt authority when the locked coalesce target has changed", async () => {
    const writer = createFakeAdmissionWriter({ coalesceIntoActiveExecutionRun: vi.fn(async () => null) });
    const reader = createFakeAdmissionReader();
    const admit = createAdmitWakeBehindIssueExecution({ reader, writer, helpers: createFakeAdmissionHelpers() });
    const durableReceipt = { id: "incoming-source", requestedAt: new Date("2026-11-04T00:00:00Z") };
    expect(await admit(SCOPE, admissionInput({ durableReceipt, wakeCommentId: "new-comment",
      contextSnapshot: { issueId: "issue-1", wakeCommentId: "new-comment" }, payload: { issueId: "issue-1", commentId: "new-comment" },
    }))).toEqual({ kind: "deferred" });
    expect(writer.insertNewDeferredWake).toHaveBeenCalledWith(SCOPE, expect.objectContaining({
      companyId: "company-1", agentId: "wake-agent", durableReceipt,
      requestedByActorType: "user", requestedByActorId: "user-1",
      payload: expect.objectContaining({ issueId: "issue-1", commentId: "new-comment" }),
    }));
    expect(writer.mergeIntoExistingDeferredWake).not.toHaveBeenCalled();
  });

  it("merges into the existing deferred wake when the policy returns a merge target", async () => {
    const mergeIntoExistingDeferredWake = vi.fn(
      async (_scope: TransactionScope, _input: Parameters<WakeAdmissionWriter["mergeIntoExistingDeferredWake"]>[1]) => {},
    );
    const writer = createFakeAdmissionWriter({ mergeIntoExistingDeferredWake });
    const reader = createFakeAdmissionReader({
      isSameExecutionAgent: vi.fn(async () => false),
      findExistingDeferredWake: vi.fn(async () => ({
        id: "deferred-1",
        payload: { issueId: "issue-1", foo: "bar" },
        deferredContext: { wakeReason: "issue_commented" },
        coalescedCount: 2,
      })),
    });
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({ reader, writer, helpers });

    const result = await admit(SCOPE, admissionInput());

    expect(result).toEqual({ kind: "deferred" });
    expect(mergeIntoExistingDeferredWake).toHaveBeenCalledTimes(1);
    const call = mergeIntoExistingDeferredWake.mock.calls[0]![1];
    expect(call.existingDeferredWakeId).toBe("deferred-1");
    expect(call.nextCoalescedCount).toBe(3);
    expect(call.mergedPayload.foo).toBe("bar");
    expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
    expect(writer.insertNewDeferredWake).not.toHaveBeenCalled();
  });

  it("inserts a new deferred wake when a different agent holds the lock and none is queued yet", async () => {
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader({ isSameExecutionAgent: vi.fn(async () => false) });
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({ reader, writer, helpers });

    const result = await admit(SCOPE, admissionInput());

    expect(result).toEqual({ kind: "deferred" });
    expect(writer.insertNewDeferredWake).toHaveBeenCalledTimes(1);
    expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
    expect(writer.mergeIntoExistingDeferredWake).not.toHaveBeenCalled();
  });

  it("proceeds, and never reads for an existing deferred wake, when the zombie-run filter leaves no live coalesce target", async () => {
    const writer = createFakeAdmissionWriter();
    const reader = createFakeAdmissionReader();
    const helpers = createFakeAdmissionHelpers();
    const admit = createAdmitWakeBehindIssueExecution({ reader, writer, helpers });

    const result = await admit(SCOPE, admissionInput({ liveRunExecutions: { has: () => false } }));

    expect(result).toEqual({ kind: "proceed" });
    expect(reader.findExistingDeferredWake).not.toHaveBeenCalled();
    expect(writer.coalesceIntoActiveExecutionRun).not.toHaveBeenCalled();
    expect(writer.mergeIntoExistingDeferredWake).not.toHaveBeenCalled();
    expect(writer.insertNewDeferredWake).not.toHaveBeenCalled();
  });
});

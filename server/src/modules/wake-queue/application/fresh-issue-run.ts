import { isUuidLike } from "@paperclipai/shared";
import {
  DEFERRED_WAKE_CONTEXT_KEY,
  queuedCommentIdsFromRunContext,
  queuedCommentIdsFromWakePayload,
  withQueuedCommentIdsInRunContext,
  withQueuedCommentIdsInWakePayload,
} from "../../../lib/queued-comment-context.js";
import { hasInteractionContinuationWakeContext, isInteractionResolutionWakePayload } from "../domain/context.js";
import { parseObject, readNonEmptyString } from "../domain/values.js";
import type { DurableWakeAdmissionReceipt } from "./ports.js";

type WakeReceiptSeed = {
  agentId: string;
  source: string;
  triggerDetail: string | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  requestedByActorType: string | null;
  requestedByActorId: string | null;
  idempotencyKey: string | null;
};

type QueuedRunSeed = {
  id?: string;
  agentId: string;
  scopeKind: "issue" | "company";
  issueId: string | null;
  invocationSource: string;
  triggerDetail: string | null;
  responsibleUserId: string;
  wakeupRequestId: string;
  retryOfRunId: string | null;
  contextSnapshot: Record<string, unknown>;
  sessionIdBefore: string | null;
  continuationAttempt: number;
  scheduledRetryAttempt?: number;
  scheduledRetryReason?: "transient_failure";
};

type SaveWakeReceipt =
  | { kind: "insert"; seed: WakeReceiptSeed & Partial<DurableWakeAdmissionReceipt> }
  | { kind: "promote"; wakeId: string; agentId: string; payload: WakeReceiptSeed["payload"] };

type DeferredCommentCandidate = {
  id: string;
  reason: string | null;
  idempotencyKey: string | null;
  payload: unknown;
};

export type FreshIssueRunStore<Run> = {
  saveReceipt(input: SaveWakeReceipt): Promise<{ id: string } | undefined>;
  readCommentCandidates(input: {
    issueId: string;
    agentId: string;
    handoffRunId: string | null;
    receiptScope: { kind: "all" } | { kind: "exact"; wakeId: string } | null;
    checkExecutionBlocker: boolean;
  }): Promise<{ handoffAgentId: string | null; candidates: DeferredCommentCandidate[] }>;
  readUndeliveredLegacyCommentIds(issueId: string, agentId: string, commentIds: string[]): Promise<string[]>;
  notifyRunMilestones(issueId: string): Promise<void>;
  insertQueuedRun(seed: QueuedRunSeed): Promise<Run>;
  bindReceipts(input: {
    wakeId: string;
    runId: string;
    failedChatRetryReceiptId?: string;
    adopted?: { wakeIds: string[]; payload: Record<string, unknown> };
  }): Promise<void>;
};

type FreshIssueRunInput = {
  receipt: WakeReceiptSeed;
  issue: { id: string; assigneeAgentId: string | null; isConversation: boolean };
  durableReceipt?: DurableWakeAdmissionReceipt;
  durableChatReceiptId?: string;
  allowRunCoalescing?: boolean;
  executionWaitRequestId?: string;
  queuedCommentInterruptId?: string;
  queuedCommentRequestId?: string;
  boardRetryReceiptId?: string;
  failedChatRetryReceiptId?: string;
  ownsReconstructionContinuation: boolean;
  contextSnapshot: Record<string, unknown>;
  resolveSessionIdBefore(): Promise<string | null>;
  continuationAttempt: number;
  explicitContinuationRunId: string | null;
  retryOfRunId: string | null;
  reconciledSourceRunId: string | null;
  reconciledRestoreRetryCount: number | null;
  resolveResponsibleUserId(): Promise<string>;
  recordContinuationDelivery(runId: string): Promise<void>;
};

function isOrdinaryBoardComment(wake: DeferredCommentCandidate): boolean {
  const payload = parseObject(wake.payload);
  const context = parseObject(payload[DEFERRED_WAKE_CONTEXT_KEY]);
  // Durable chat and interaction wakes carry their own actor, source, and session.
  return !wake.idempotencyKey?.startsWith("chat-inbound:") &&
    !isInteractionResolutionWakePayload(payload) &&
    !hasInteractionContinuationWakeContext(context) &&
    ["issue_commented", "issue_reopened_via_comment"].includes(String(context.wakeReason ?? wake.reason)) &&
    queuedCommentIdsFromWakePayload(payload).length > 0;
}

/** Admit one new run and its saved inputs under the issue admission lock. */
export function createFreshIssueRunAdmission<Run extends { id: string }>(store: FreshIssueRunStore<Run>) {
  return async function admitFreshIssueRun(input: FreshIssueRunInput): Promise<Run | undefined> {
    const { receipt, durableReceipt, durableChatReceiptId, executionWaitRequestId, issue, contextSnapshot } = input;
    const { agentId, source, triggerDetail, reason, payload } = receipt;

    // A deferred durable chat wake keeps its original identity and source.
    const primary = await store.saveReceipt(durableChatReceiptId && durableChatReceiptId === executionWaitRequestId
      ? { kind: "promote", wakeId: durableChatReceiptId, agentId, payload }
      : {
          kind: "insert",
          seed: durableReceipt ? { ...receipt, id: durableReceipt.id, requestedAt: durableReceipt.requestedAt } : receipt,
        });
    if (!primary) return undefined;

    // Only a verified reassignment can bring a previous executor's saved comments.
    const interruptedRunId = readNonEmptyString(contextSnapshot.interruptedRunId);
    const handoffRunId = source === "assignment" && reason === "issue_assigned" &&
      issue.assigneeAgentId === agentId && interruptedRunId && isUuidLike(interruptedRunId)
      ? interruptedRunId : null;

    // Chat keeps separate batches, but an exact resumed receipt must be consumed with its successor.
    const canCoalesceComments = !durableChatReceiptId && !issue.isConversation && input.allowRunCoalescing !== false;
    const { handoffAgentId, candidates } = await store.readCommentCandidates({
      issueId: issue.id,
      agentId,
      handoffRunId,
      receiptScope: canCoalesceComments || (executionWaitRequestId && input.boardRetryReceiptId)
        ? { kind: "all" }
        : executionWaitRequestId ? { kind: "exact", wakeId: executionWaitRequestId } : null,
      checkExecutionBlocker: !input.ownsReconstructionContinuation,
    });
    const adopted = candidates.filter((wake) => wake.id === executionWaitRequestId ||
      wake.id === input.queuedCommentInterruptId || wake.id === input.queuedCommentRequestId ||
      isOrdinaryBoardComment(wake));
    const adoptedWakeIds = adopted.map((wake) => wake.id);
    let commentIds = [...new Set([
      ...adopted.flatMap((wake) => queuedCommentIdsFromWakePayload(wake.payload)),
      ...queuedCommentIdsFromRunContext(contextSnapshot),
    ])];
    if (input.queuedCommentRequestId || input.boardRetryReceiptId || handoffAgentId) {
      commentIds = await store.readUndeliveredLegacyCommentIds(issue.id, agentId, commentIds);
    }

    await store.notifyRunMilestones(issue.id);
    const responsibleUserId = await input.resolveResponsibleUserId();
    const scopedIssueId = readNonEmptyString(contextSnapshot.issueId);
    const run = await store.insertQueuedRun({
      ...(input.explicitContinuationRunId ? { id: input.explicitContinuationRunId } : {}),
      agentId,
      scopeKind: scopedIssueId ? "issue" : "company",
      issueId: scopedIssueId,
      invocationSource: source,
      triggerDetail,
      responsibleUserId,
      wakeupRequestId: primary.id,
      retryOfRunId: input.reconciledSourceRunId || input.retryOfRunId,
      contextSnapshot: adopted.length ? withQueuedCommentIdsInRunContext(contextSnapshot, commentIds, adoptedWakeIds) : contextSnapshot,
      sessionIdBefore: input.explicitContinuationRunId ? null : await input.resolveSessionIdBefore(),
      continuationAttempt: input.continuationAttempt,
      ...(input.reconciledRestoreRetryCount !== null ? {
        scheduledRetryAttempt: input.reconciledRestoreRetryCount,
        scheduledRetryReason: "transient_failure",
      } : {}),
    });
    await input.recordContinuationDelivery(run.id);
    await store.bindReceipts({
      wakeId: primary.id,
      runId: run.id,
      failedChatRetryReceiptId: input.failedChatRetryReceiptId,
      adopted: adopted.length ? {
        wakeIds: adoptedWakeIds,
        payload: withQueuedCommentIdsInWakePayload(payload, commentIds),
      } : undefined,
    });
    return run;
  };
}

import {
  DEFERRED_WAKE_CONTEXT_KEY,
  queuedCommentIdsFromRunContext,
  withQueuedCommentIdsInWakePayload,
} from "../../../lib/queued-comment-context.js";
import { hasInteractionContinuationWakeContext } from "../domain/context.js";
import { readNonEmptyString } from "../domain/values.js";
import type { DurableWakeAdmissionReceipt, WakeReceiptSeed } from "./ports.js";

type DeferralCondition = { recoveryActionId: string | null; reason: string; message: string };
type ReceiptSeed = WakeReceiptSeed & Partial<DurableWakeAdmissionReceipt>;

export type WakeRecoveryDeferralStore<Publication> = {
  updateWait(input: { requestId: string; agentId: string; condition: DeferralCondition; publications: Publication[] }): Promise<boolean>;
  insertDeferred(request: ReceiptSeed): Promise<void>;
  recordWait(input: { request: ReceiptSeed; condition: DeferralCondition; nextAction: string; coalesce: boolean }): Promise<void>;
};

export function createWakeRecoveryDeferral<Publication>(
  issueId: string,
  durableChat: boolean,
  store: WakeRecoveryDeferralStore<Publication>,
) {
  return async function defer({
    request, existingRequestId, commentId, contextSnapshot, condition, nextAction, coalesce, publications,
  }: {
    request: ReceiptSeed;
    existingRequestId?: string;
    commentId?: string | null;
    contextSnapshot: Record<string, unknown>;
    condition: DeferralCondition;
    nextAction: string;
    coalesce: boolean;
    publications: Publication[];
  }): Promise<{ kind: "deferred"; admitted?: true }> {
    if (existingRequestId) {
      const saved = await store.updateWait({ requestId: existingRequestId, agentId: request.agentId, condition, publications });
      return saved ? { kind: "deferred", admitted: true } : { kind: "deferred" };
    }
    if (durableChat || commentId || hasInteractionContinuationWakeContext(contextSnapshot) ||
      readNonEmptyString(contextSnapshot.nativeStatusWakeIntentId)) {
      const commentIds = [...new Set([...queuedCommentIdsFromRunContext(contextSnapshot), ...(commentId ? [commentId] : [])])];
      await store.insertDeferred({
        ...request,
        payload: withQueuedCommentIdsInWakePayload({
          ...request.payload, issueId,
          [DEFERRED_WAKE_CONTEXT_KEY]: contextSnapshot,
          executionWait: condition,
        }, commentIds),
      });
    } else {
      await store.recordWait({ request, condition, nextAction, coalesce });
    }
    return { kind: "deferred", admitted: true };
  };
}

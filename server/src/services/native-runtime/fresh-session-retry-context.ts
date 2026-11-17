import { extractWakeCommentIds } from "../../modules/run-dispatch/index.js";
import { boundExternalChatProvider } from "./external-chat-provider.js";

// Resume receipts and delivered wake input belong to the failed run. An
// automatic fresh-session successor has ordinary task authority; its history
// comes from retryOfRunId.
const CONSUMED_WAKE_INPUT_KEYS = [
  "explicitUserContinuation", "wakeCommentId", "wakeCommentIds", "commentId",
  "commentIds", "latestCommentId", "resumeIntent", "followUpRequested",
  "paperclipWake", "paperclipWakeComment", "paperclipTaskMarkdown", "paperclipTaskMarkdownCompact",
  "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownAssignmentCompact", "paperclipTurnContext",
] as const;

// Proofs the failed run earned at dispatch. A successor never inherits them.
const DISPATCH_ATTESTATION_KEYS = ["paperclipHarnessCheckedOut", "paperclipExternalChatExecutionBound"] as const;

/**
 * Context for an automatic fresh-session successor of a failed native run.
 * A run-bound external chat turn keeps its admitted message references, not
 * the failed run's authority: dispatch must prove the successor owns the task
 * and recheck current endpoint, conversation and principal access for the
 * whole batch. Without them, a chat turn on a task in review can never pass
 * that check.
 */
export function freshSessionRetryContext(predecessor: Record<string, unknown> | null | undefined) {
  const context: Record<string, unknown> = { ...predecessor };
  const chatCommentIds = boundExternalChatProvider(context.source) ? extractWakeCommentIds(context) : [];
  for (const key of CONSUMED_WAKE_INPUT_KEYS) delete context[key];
  if (chatCommentIds.length === 0) return context;
  for (const key of DISPATCH_ATTESTATION_KEYS) delete context[key];
  return {
    ...context,
    wakeCommentIds: chatCommentIds,
    wakeCommentId: chatCommentIds.at(-1),
    commentId: chatCommentIds.at(-1),
  };
}

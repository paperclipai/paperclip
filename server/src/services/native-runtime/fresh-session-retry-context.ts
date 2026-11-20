import { extractWakeCommentIds } from "../../modules/run-dispatch/index.js";
import { boundExternalChatProvider } from "./external-chat-provider.js";

const CONSUMED_WAKE_INPUT_KEYS = [
  "explicitUserContinuation", "wakeCommentId", "wakeCommentIds", "commentId",
  "commentIds", "latestCommentId", "resumeIntent", "followUpRequested",
  "paperclipWake", "paperclipWakeComment", "paperclipTaskMarkdown", "paperclipTaskMarkdownCompact",
  "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownAssignmentCompact", "paperclipTurnContext",
] as const;

const DISPATCH_ATTESTATION_KEYS = ["paperclipHarnessCheckedOut", "paperclipExternalChatExecutionBound"] as const;

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

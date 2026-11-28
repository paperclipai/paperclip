export const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
export const WAKE_COMMENT_IDS_KEY = "wakeCommentIds";

function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate) => {
    if (typeof candidate !== "string" || !candidate || seen.has(candidate)) return [];
    seen.add(candidate);
    return [candidate];
  });
}

export function queuedCommentIdsFromWakePayload(payloadValue: unknown): string[] {
  const payload = parseObject(payloadValue);
  const context = parseObject(payload[DEFERRED_WAKE_CONTEXT_KEY]);
  return uniqueIds(context[WAKE_COMMENT_IDS_KEY]);
}

export function queuedCommentIdsFromRunContext(contextValue: unknown): string[] {
  return uniqueIds(parseObject(contextValue)[WAKE_COMMENT_IDS_KEY]);
}

export function withQueuedCommentIdsInWakePayload(
  payloadValue: unknown,
  ids: string[],
  options: { preserveSource?: boolean } = {},
): Record<string, unknown> {
  const payload = { ...parseObject(payloadValue) };
  const context = { ...parseObject(payload[DEFERRED_WAKE_CONTEXT_KEY]) };
  if (ids.length > 0) {
    const latestId = ids[ids.length - 1]!;
    context[WAKE_COMMENT_IDS_KEY] = ids;
    if (!options.preserveSource) {
      context.wakeCommentId = latestId;
      context.commentId = latestId;
      payload.commentId = latestId;
    }
  } else {
    delete context[WAKE_COMMENT_IDS_KEY];
    delete context.wakeCommentId;
    delete context.commentId;
    delete payload.commentId;
  }
  payload[DEFERRED_WAKE_CONTEXT_KEY] = context;
  return payload;
}

export function withQueuedCommentIdsInRunContext(
  contextValue: unknown,
  ids: string[],
  sourceWakeIds?: string[],
): Record<string, unknown> {
  const context = { ...parseObject(contextValue) };
  if (sourceWakeIds) {
    context.queuedCommentSourceWakeIds = uniqueIds([
      ...uniqueIds(context.queuedCommentSourceWakeIds),
      ...sourceWakeIds,
    ]);
  }
  if (ids.length > 0) {
    const latestId = ids[ids.length - 1]!;
    context[WAKE_COMMENT_IDS_KEY] = ids;
    context.wakeCommentId = latestId;
    context.commentId = latestId;
  } else {
    delete context[WAKE_COMMENT_IDS_KEY];
    delete context.wakeCommentId;
    delete context.commentId;
  }

  // These projections are generated immediately before dispatch. Any queue
  // mutation must force them to be rebuilt from the canonical comment ids.
  delete context.paperclipWake;
  delete context.paperclipWakeComment;
  delete context.paperclipTaskMarkdown;
  delete context.paperclipTaskMarkdownCompact;
  delete context.paperclipTaskMarkdownAssignment;
  delete context.paperclipTaskMarkdownAssignmentCompact;
  delete context.paperclipTurnContext;
  return context;
}

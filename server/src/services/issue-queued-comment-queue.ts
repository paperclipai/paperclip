const QUEUE_CONTEXT_KEY = "_paperclipWakeContext";
const QUEUE_IDS_KEY = "wakeCommentIds";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
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
  const payload = record(payloadValue);
  const context = record(payload[QUEUE_CONTEXT_KEY]);
  return uniqueIds(context[QUEUE_IDS_KEY]);
}

export function queuedCommentIdsFromRunContext(contextValue: unknown): string[] {
  return uniqueIds(record(contextValue)[QUEUE_IDS_KEY]);
}

export function withQueuedCommentIdsInWakePayload(
  payloadValue: unknown,
  ids: string[],
): Record<string, unknown> {
  const payload = { ...record(payloadValue) };
  const context = { ...record(payload[QUEUE_CONTEXT_KEY]) };
  if (ids.length > 0) {
    const latestId = ids[ids.length - 1]!;
    context[QUEUE_IDS_KEY] = ids;
    context.wakeCommentId = latestId;
    context.commentId = latestId;
    payload.commentId = latestId;
  } else {
    delete context[QUEUE_IDS_KEY];
    delete context.wakeCommentId;
    delete context.commentId;
    delete payload.commentId;
  }
  payload[QUEUE_CONTEXT_KEY] = context;
  return payload;
}

export function withQueuedCommentIdsInRunContext(
  contextValue: unknown,
  ids: string[],
): Record<string, unknown> {
  const context = { ...record(contextValue) };
  if (ids.length > 0) {
    const latestId = ids[ids.length - 1]!;
    context[QUEUE_IDS_KEY] = ids;
    context.wakeCommentId = latestId;
    context.commentId = latestId;
  } else {
    delete context[QUEUE_IDS_KEY];
    delete context.wakeCommentId;
    delete context.commentId;
  }

  // These projections are generated immediately before dispatch. Any queue
  // mutation must force them to be rebuilt from the canonical comment ids.
  delete context.paperclipWake;
  delete context.paperclipWakeComment;
  delete context.paperclipTaskMarkdown;
  delete context.paperclipTaskMarkdownCompact;
  return context;
}

// Shared wake-reason and retry-reason constants, and the pure classifiers
// that read them off a run's context snapshot. `heartbeat.ts` and this
// module's own Postgres adapter both decide on the same context snapshot
// shape, so this file is their one shared source for it: a second,
// independently maintained copy in either file could silently drift out of
// sync with the other and change only one of the two gates that read it.

function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export const MAX_TURN_CONTINUATION_RETRY_REASON = "max_turns_continuation";
export const PENDING_INTERACTION_WAKE_REASON = "interaction_pending";
/**
 * A bounded retry rewrites `wakeReason` (for example to
 * `transient_failure_retry`), but the run keeps the authority of the wake it
 * retries. This key carries that original identity forward so a gate that
 * reads the wake reason still sees it after the rewrite.
 */
export const ORIGINAL_WAKE_REASON_KEY = "originalWakeReason";
export const WORKSPACE_BUSY_RETRY_REASON = "workspace_busy";
export const AI_CONNECTION_POOL_WAIT_RETRY_REASON = "ai_connection_pool_wait";
export const AI_CONNECTION_BUSY_RETRY_REASON = "ai_connection_busy";
export const INTERACTION_CONTINUATION_INFRA_RETRY_REASON = "interaction_continuation_infra_retry";
export const INTERACTION_CONTINUATION_INFRA_WAKE_REASON = "interaction_continuation_infra_retry";
export const WAKE_COMMENT_IDS_KEY = "wakeCommentIds";
export const RESOLVED_INTERACTION_CONTINUATION_STATUSES = new Set([
  "accepted",
  "answered",
  "cancelled",
  "rejected",
]);

/**
 * True for a resource-wait retry whose original run did not
 * execute under assignee-ship (a comment or review-participant wake). Such a
 * retry has an expected assignee mismatch, so the scheduled-retry gate and
 * the queued-run staleness check must not treat it as a reassignment.
 */
export function isNonAssigneeWorkspaceBusyRetry(
  retryReason: string | null | undefined,
  contextSnapshot: Record<string, unknown>,
): boolean {
  return (
    (retryReason === WORKSPACE_BUSY_RETRY_REASON &&
      contextSnapshot.workspaceBusyDeferredWhileAssignee === false) ||
    ((retryReason === AI_CONNECTION_BUSY_RETRY_REASON || retryReason === AI_CONNECTION_POOL_WAIT_RETRY_REASON) &&
      contextSnapshot.aiConnectionBusyDeferredWhileAssignee === false)
  );
}

export function extractWakeCommentIds(
  contextSnapshot: Record<string, unknown> | null | undefined,
): string[] {
  const raw = contextSnapshot?.[WAKE_COMMENT_IDS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const value = readNonEmptyString(entry);
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

export function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload?: Record<string, unknown> | null,
): string | null {
  const batchedCommentId = extractWakeCommentIds(contextSnapshot).at(-1);
  return (
    batchedCommentId ??
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

/**
 * The external chat conversation a wake answers. Several conversations can
 * share one issue (for example GitHub review finding threads), but a reviewed
 * chat run can attest only one, so wakes for different conversations must
 * never share a batch.
 */
export const CHAT_CONVERSATION_ID_KEY = "chatConversationId";

export function readWakeChatConversationId(contextSnapshot: unknown): string | null {
  return readNonEmptyString(parseObject(contextSnapshot)[CHAT_CONVERSATION_ID_KEY]);
}

/** True when both wakes answer a chat conversation and they are different ones. */
export function wakeChatConversationsConflict(existing: unknown, incoming: unknown): boolean {
  const existingId = readWakeChatConversationId(existing);
  const incomingId = readWakeChatConversationId(incoming);
  return existingId !== null && incomingId !== null && existingId !== incomingId;
}

/**
 * `allowedWakeReasons` is the issue-tree-control module's own set of wake
 * reasons that excuse an interaction wake. This file stays free of service
 * imports, so the caller passes the set in rather than this function reading
 * it from the service directly.
 */
export function allowsIssueInteractionWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
  allowedWakeReasons: ReadonlySet<string>,
): boolean {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (!wakeReason || !allowedWakeReasons.has(wakeReason)) return false;
  return Boolean(deriveCommentId(contextSnapshot));
}

/**
 * Reads the interaction id from a pending-card wake snapshot. A bounded retry
 * keeps the card identity in `originalWakeReason` while its own `wakeReason`
 * records the retry, so both shapes name the same authority. This is only an
 * identifier: the caller must still verify in the database that the
 * interaction is pending and addressed to the run's agent before treating it
 * as authority to run outside assignee-ship.
 */
export function readPendingInteractionWakeId(
  contextSnapshot: Record<string, unknown> | null | undefined,
): string | null {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  const originalWakeReason = readNonEmptyString(
    contextSnapshot?.[ORIGINAL_WAKE_REASON_KEY],
  );
  if (
    wakeReason !== PENDING_INTERACTION_WAKE_REASON &&
    originalWakeReason !== PENDING_INTERACTION_WAKE_REASON
  ) {
    return null;
  }
  return readNonEmptyString(contextSnapshot?.interactionId);
}

export function isResolvedInteractionContinuationWakeContext(contextSnapshot: unknown): boolean {
  const context = parseObject(contextSnapshot);
  const interactionId = readNonEmptyString(context.interactionId);
  const interactionStatus = readNonEmptyString(context.interactionStatus);
  if (!interactionId || !interactionStatus) return false;
  const retiredConnection = interactionStatus === "expired"
    && context.interactionKind === "connection_intent"
    && context.connectionIntentResolution === "existing_connection";
  if (!retiredConnection && !RESOLVED_INTERACTION_CONTINUATION_STATUSES.has(interactionStatus)) return false;

  const mutation = readNonEmptyString(context.mutation);
  const wakeReason = readNonEmptyString(context.wakeReason);
  const retryReason = readNonEmptyString(context.retryReason);
  return (
    (mutation === "interaction" && wakeReason === "issue_commented") ||
    wakeReason === INTERACTION_CONTINUATION_INFRA_WAKE_REASON ||
    retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON
  );
}

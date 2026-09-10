// Pure helpers that build the context snapshot for a promoted deferred wake.
// `extractWakeCommentIds`, `deriveCommentId`, and `WAKE_COMMENT_IDS_KEY` come
// from the run-dispatch module so the two modules read one wake context
// shape; this file holds only the small pieces that are specific to
// building the release half's promoted-run snapshot.

import { extractWakeCommentIds, WAKE_COMMENT_IDS_KEY } from "../../run-dispatch/index.js";

const PAPERCLIP_WAKE_PAYLOAD_KEY = "paperclipWake";
const PAPERCLIP_WAKE_COMMENT_KEY = "paperclipWakeComment";
const PAPERCLIP_TASK_MARKDOWN_KEY = "paperclipTaskMarkdown";
const PAPERCLIP_TASK_MARKDOWN_COMPACT_KEY = "paperclipTaskMarkdownCompact";

const INTERACTION_CONTINUATION_CONTEXT_KEYS = [
  "interactionId",
  "interactionKind",
  "interactionStatus",
  "continuationPolicy",
  "checkboxSelection",
  "itemVerdicts",
  "newlyResolvedItemIds",
] as const;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
): string | null {
  return (
    readNonEmptyString(contextSnapshot?.taskKey) ??
    readNonEmptyString(contextSnapshot?.taskId) ??
    readNonEmptyString(contextSnapshot?.issueId) ??
    readNonEmptyString(payload?.taskKey) ??
    readNonEmptyString(payload?.taskId) ??
    readNonEmptyString(payload?.issueId) ??
    null
  );
}

function mergeWakeCommentIds(...values: Array<unknown>): string[] {
  const merged: string[] = [];
  const append = (value: unknown) => {
    const normalized = readNonEmptyString(value);
    if (!normalized || merged.includes(normalized)) return;
    merged.push(normalized);
  };
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const entry of value) append(entry);
      continue;
    }
    if (typeof value === "object" && value !== null) {
      const candidate = value as Record<string, unknown>;
      const batched = extractWakeCommentIds(candidate);
      if (batched.length > 0) {
        for (const entry of batched) append(entry);
        continue;
      }
      append(candidate.wakeCommentId);
      append(candidate.commentId);
      continue;
    }
    append(value);
  }
  return merged;
}

export function hasInteractionContinuationWakeContext(contextSnapshot: Record<string, unknown>): boolean {
  return INTERACTION_CONTINUATION_CONTEXT_KEYS.some((key) => readNonEmptyString(contextSnapshot[key]));
}

function isInteractionResolutionWakePayload(payload: Record<string, unknown> | null | undefined): boolean {
  return readNonEmptyString(payload?.mutation) === "interaction";
}

function normalizeInteractionContinuationWakeContext(
  contextSnapshot: Record<string, unknown>,
  payload: Record<string, unknown> | null | undefined,
): void {
  if (isInteractionResolutionWakePayload(payload)) return;
  for (const key of INTERACTION_CONTINUATION_CONTEXT_KEYS) {
    delete contextSnapshot[key];
  }
}

export type EnrichPromotedWakeContextInput = {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: string | null;
  triggerDetail: string | null;
  payload: Record<string, unknown> | null;
};

export type EnrichPromotedWakeContextResult = {
  contextSnapshot: Record<string, unknown>;
  taskKey: string | null;
};

/**
 * Fills the promoted run's context snapshot with the fields the original
 * wake enrichment always fills, without overwriting a field the deferred
 * wake already carried. The deferred wake's own context snapshot was
 * already enriched once when it was first queued, so most calls only
 * normalize the interaction-continuation keys.
 */
export function enrichPromotedWakeContext(
  input: EnrichPromotedWakeContextInput,
): EnrichPromotedWakeContextResult {
  const contextSnapshot = { ...input.contextSnapshot };
  const { reason, source, triggerDetail, payload } = input;
  const commentIdFromPayload = readNonEmptyString(payload?.["commentId"]);
  const taskKey = deriveTaskKey(contextSnapshot, payload);
  const wakeCommentIds = mergeWakeCommentIds(contextSnapshot, commentIdFromPayload);

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (!readNonEmptyString(contextSnapshot["commentId"]) && commentIdFromPayload) {
    contextSnapshot.commentId = commentIdFromPayload;
  }
  // The wake payload, resolved comment, and task-markdown snapshots below are
  // all derived from the canonical comment ids. This function recomputes
  // those ids on every call (`wakeCommentIds`), so it must not let a
  // derived projection from a stale id list carry forward: clear all four,
  // then restore only the canonical id and latest-id fields, and only when
  // the recomputed list actually has entries.
  delete contextSnapshot[PAPERCLIP_WAKE_PAYLOAD_KEY];
  delete contextSnapshot[PAPERCLIP_WAKE_COMMENT_KEY];
  delete contextSnapshot[PAPERCLIP_TASK_MARKDOWN_KEY];
  delete contextSnapshot[PAPERCLIP_TASK_MARKDOWN_COMPACT_KEY];
  if (wakeCommentIds.length > 0) {
    const latestCommentId = wakeCommentIds[wakeCommentIds.length - 1];
    contextSnapshot[WAKE_COMMENT_IDS_KEY] = wakeCommentIds;
    contextSnapshot.commentId = latestCommentId;
    contextSnapshot.wakeCommentId = latestCommentId;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (!readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) && triggerDetail) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }
  normalizeInteractionContinuationWakeContext(contextSnapshot, payload);

  return { contextSnapshot, taskKey };
}

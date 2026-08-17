import type { IssueCommentFeedbackDelivery, IssueRecoveryActionStatus } from "@paperclipai/shared";

import {
  FEEDBACK_DELIVERY_MAX_AUTOMATIC_RETRIES,
  FEEDBACK_DELIVERY_RECOVERY_CAUSE,
} from "./feedback-delivery.js";

/**
 * How long a recovered-after-attention notice keeps its own projected state.
 * After this the comment falls back to no delivery state at all; the audit
 * trail lives in activity history, not in a permanently decorated comment.
 */
export const FEEDBACK_DELIVERY_RECOVERED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Operator-safe failure vocabulary. Run/gate failure codes are mapped through
 * this whitelist so no adapter message, stack frame, request body, credential,
 * or filesystem path can reach a comment surface. An unrecognized code is
 * deliberately collapsed to `null` rather than echoed: the banner copy already
 * states the operator-relevant fact ("Paperclip stopped retrying").
 */
const SAFE_FAILURE_REASONS: Record<string, string> = {
  agent_not_found: "The assigned agent no longer exists.",
  agent_not_invokable: "The assigned agent can't be started right now.",
  budget_blocked: "The agent is over its budget.",
  issue_paused: "Work on this task is paused.",
  issue_dependencies_blocked: "This task is waiting on a blocker.",
  issue_assignee_changed: "The assignee changed while delivering.",
  issue_reassigned: "The assignee changed while delivering.",
  issue_execution_lock_changed: "Another run took over this task.",
  issue_review_participant_changed: "The review owner changed while delivering.",
  issue_terminal_status: "The task was closed while delivering.",
  process_lost: "The agent's process stopped before it read the comment.",
  server_shutdown_interrupted: "Paperclip restarted before the agent read the comment.",
  workspace_validation_failed: "The task's workspace couldn't be prepared.",
  configuration_validation_failed: "Required agent configuration is missing.",
};

export function toSafeFeedbackDeliveryFailureReason(
  code: string | null | undefined,
): string | null {
  if (typeof code !== "string") return null;
  const normalized = code.trim();
  if (!normalized) return null;
  return SAFE_FAILURE_REASONS[normalized] ?? null;
}

/** Minimal recovery-action shape this projection needs. */
export type FeedbackDeliveryRecoveryActionRow = {
  id: string;
  kind: string;
  cause: string;
  /** Raw DB column: narrowed against the active-status list rather than cast. */
  status: string;
  fingerprint: string;
  evidence: unknown;
  /** Original assignee, used to build the run route for `sourceRunId`. */
  previousOwnerAgentId: string | null;
  attemptCount: number;
  maxAttempts: number | null;
  lastAttemptAt: Date | string | null;
  resolvedAt: Date | string | null;
  createdAt: Date | string;
};

/**
 * A replay this issue is currently waiting on: either a queued wake or a
 * queued/scheduled run that carries feedback-delivery context.
 */
export type FeedbackDeliveryPendingReplay = {
  fingerprint: string | null;
  agentId: string;
  commentIds: readonly string[];
  generation: number;
  runId: string | null;
  nextAttemptAt: Date | string | null;
  requestedAt: Date | string | null;
};

export type FeedbackDeliveryProjectionInput = {
  recoveryActions: readonly FeedbackDeliveryRecoveryActionRow[];
  pendingReplays: readonly FeedbackDeliveryPendingReplay[];
  /** Whether this viewer may request one more explicit delivery attempt. */
  viewerCanRetry: boolean;
  /** Whether this viewer may open run detail. Gates `targetRunId` entirely. */
  viewerCanReadRuns: boolean;
  now: Date;
  recoveredWindowMs?: number;
};

const ACTIVE_STATUSES: readonly string[] = [
  "active",
  "escalated",
] satisfies readonly IssueRecoveryActionStatus[];

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toMillis(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function readEvidenceCommentIds(evidence: unknown): string[] {
  if (typeof evidence !== "object" || evidence === null) return [];
  const raw = (evidence as Record<string, unknown>).outstandingCommentIds;
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed && !ids.includes(trimmed)) ids.push(trimmed);
  }
  return ids;
}

function readEvidenceString(evidence: unknown, key: string): string | null {
  if (typeof evidence !== "object" || evidence === null) return null;
  const raw = (evidence as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function readEvidenceNumber(evidence: unknown, key: string): number | null {
  if (typeof evidence !== "object" || evidence === null) return null;
  const raw = (evidence as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function isFeedbackDeliveryAction(action: FeedbackDeliveryRecoveryActionRow) {
  return action.kind === "feedback_delivery" && action.cause === FEEDBACK_DELIVERY_RECOVERY_CAUSE;
}

/**
 * Projects feedback-delivery state onto the individual human comments it
 * belongs to.
 *
 * Precedence is deliberate:
 * 1. An active/escalated recovery action always wins, because the operator must
 *    keep seeing the actionable banner until the obligation is discharged — an
 *    in-flight explicit retry surfaces as `retryInFlight`, not as a state change
 *    that would make the banner (and its attention item) disappear.
 * 2. Otherwise a queued replay renders the quiet `retrying` footer line.
 * 3. Otherwise a recently resolved action renders the historical recovered
 *    notice, so attention disappearing is explained rather than silent.
 *
 * A newer feedback comment never clears an older obligation: each comment id is
 * keyed independently off the evidence of the action that owns it.
 */
export function projectFeedbackDeliveryByComment(
  input: FeedbackDeliveryProjectionInput,
): Map<string, IssueCommentFeedbackDelivery> {
  const byComment = new Map<string, IssueCommentFeedbackDelivery>();
  const recoveredWindowMs = input.recoveredWindowMs ?? FEEDBACK_DELIVERY_RECOVERED_WINDOW_MS;
  const nowMs = input.now.getTime();

  const actions = input.recoveryActions.filter(isFeedbackDeliveryAction);
  const activeActions = actions.filter((action) => ACTIVE_STATUSES.includes(action.status));
  const activeFingerprints = new Set(activeActions.map((action) => action.fingerprint));

  // Recovered notices come first so an active action or queued replay for the
  // same comment overwrites them, never the other way round.
  const resolvedActions = actions
    .filter((action) => !ACTIVE_STATUSES.includes(action.status))
    // A fingerprint that resolved and then re-opened is owned by the open one.
    .filter((action) => !activeFingerprints.has(action.fingerprint))
    .filter((action) => {
      const resolvedMs = toMillis(action.resolvedAt);
      return resolvedMs !== null && nowMs - resolvedMs <= recoveredWindowMs;
    })
    // Oldest first: the freshest resolution wins a shared comment.
    .sort((a, b) => (toMillis(a.resolvedAt) ?? 0) - (toMillis(b.resolvedAt) ?? 0));

  for (const action of resolvedActions) {
    const commentIds = readEvidenceCommentIds(action.evidence);
    const targetRunId = input.viewerCanReadRuns
      ? readEvidenceString(action.evidence, "sourceRunId")
      : null;
    for (const commentId of commentIds) {
      byComment.set(commentId, {
        state: "recovered_after_attention",
        sourceCommentId: commentId,
        attempt: readEvidenceNumber(action.evidence, "retryGeneration"),
        maxAttempts: action.maxAttempts ?? FEEDBACK_DELIVERY_MAX_AUTOMATIC_RETRIES,
        nextAttemptAt: null,
        lastAttemptAt: toIso(action.lastAttemptAt),
        deliveredAt: toIso(action.resolvedAt),
        targetRunId,
        targetRunAgentId: targetRunId ? action.previousOwnerAgentId : null,
        canRetry: false,
        retryInFlight: false,
        safeFailureReason: null,
        batchedCommentCount: commentIds.length,
      });
    }
  }

  const replaysByFingerprint = new Map<string, FeedbackDeliveryPendingReplay>();
  for (const replay of input.pendingReplays) {
    if (!replay.fingerprint) continue;
    const existing = replaysByFingerprint.get(replay.fingerprint);
    if (!existing || replay.generation > existing.generation) {
      replaysByFingerprint.set(replay.fingerprint, replay);
    }
  }

  for (const replay of replaysByFingerprint.values()) {
    if (activeFingerprints.has(replay.fingerprint as string)) continue;
    for (const commentId of replay.commentIds) {
      byComment.set(commentId, {
        state: "retrying",
        sourceCommentId: commentId,
        attempt: replay.generation,
        maxAttempts: FEEDBACK_DELIVERY_MAX_AUTOMATIC_RETRIES,
        nextAttemptAt: toIso(replay.nextAttemptAt),
        lastAttemptAt: toIso(replay.requestedAt),
        deliveredAt: null,
        targetRunId: input.viewerCanReadRuns ? replay.runId : null,
        targetRunAgentId: input.viewerCanReadRuns && replay.runId ? replay.agentId : null,
        canRetry: false,
        retryInFlight: true,
        safeFailureReason: null,
        batchedCommentCount: replay.commentIds.length,
      });
    }
  }

  for (const action of activeActions) {
    const commentIds = readEvidenceCommentIds(action.evidence);
    const replay = replaysByFingerprint.get(action.fingerprint) ?? null;
    const retryInFlight = replay !== null;
    const targetRunId = input.viewerCanReadRuns
      ? replay?.runId ?? readEvidenceString(action.evidence, "sourceRunId")
      : null;
    const targetRunAgentId = !targetRunId
      ? null
      : replay?.runId === targetRunId
        ? replay.agentId
        : action.previousOwnerAgentId;
    const safeFailureReason =
      toSafeFeedbackDeliveryFailureReason(readEvidenceString(action.evidence, "lastFailureCode"))
      ?? toSafeFeedbackDeliveryFailureReason(readEvidenceString(action.evidence, "gateErrorCode"));
    for (const commentId of commentIds) {
      byComment.set(commentId, {
        state: "exhausted_needs_attention",
        sourceCommentId: commentId,
        attempt: readEvidenceNumber(action.evidence, "retryGeneration"),
        maxAttempts:
          readEvidenceNumber(action.evidence, "maxAutomaticRetries")
          ?? action.maxAttempts
          ?? FEEDBACK_DELIVERY_MAX_AUTOMATIC_RETRIES,
        nextAttemptAt: toIso(replay?.nextAttemptAt ?? null),
        lastAttemptAt: toIso(action.lastAttemptAt ?? action.createdAt),
        deliveredAt: null,
        targetRunId,
        targetRunAgentId,
        canRetry: input.viewerCanRetry && !retryInFlight,
        retryInFlight,
        safeFailureReason,
        batchedCommentCount: commentIds.length,
      });
    }
  }

  return byComment;
}

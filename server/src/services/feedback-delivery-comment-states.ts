import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions } from "@paperclipai/db";
import type { IssueCommentFeedbackDelivery } from "@paperclipai/shared";

import {
  buildFeedbackDeliveryFingerprint,
  FEEDBACK_DELIVERY_RECOVERY_ACTION_KIND,
  FEEDBACK_DELIVERY_RETRY_WAKE_REASON,
  readFeedbackDeliveryWakeCommentIds,
} from "./recovery/feedback-delivery.js";
import {
  FEEDBACK_DELIVERY_RECOVERED_WINDOW_MS,
  projectFeedbackDeliveryByComment,
  type FeedbackDeliveryPendingReplay,
} from "./recovery/feedback-delivery-projection.js";

/** Run statuses that still represent a delivery attempt the operator is waiting on. */
const PENDING_REPLAY_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;

/**
 * Wake statuses that still represent an undelivered replay. A replay deferred
 * behind a live run on the same issue is still something the operator is
 * waiting on, so it reads as `retrying` just like a queued one.
 */
const PENDING_REPLAY_WAKE_STATUSES = ["queued", "deferred_issue_execution"] as const;

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readGeneration(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * The two replay lanes spell the wake payload slightly differently — the
 * immediate lane writes `rootWakeupRequestId`/`commentIds`, the backstop lane
 * writes the run-context spelling. Read both so neither lane goes invisible.
 */
function readReplayRootWakeupRequestId(payload: Record<string, unknown>) {
  return (
    readNonEmptyString(payload.feedbackDeliveryRootWakeupRequestId)
    ?? readNonEmptyString(payload.rootWakeupRequestId)
  );
}

function readReplayCommentIds(payload: Record<string, unknown>) {
  const merged = [...readFeedbackDeliveryWakeCommentIds(payload)];
  const legacy = payload.commentIds;
  if (Array.isArray(legacy)) {
    for (const entry of legacy) {
      const normalized = readNonEmptyString(entry);
      if (normalized && !merged.includes(normalized)) merged.push(normalized);
    }
  }
  return merged;
}

/**
 * Reads the durable feedback-delivery signals for one issue and projects them
 * onto the individual human comments they belong to.
 *
 * Three cheap, index-backed reads, all scoped to the issue:
 * - `feedback_delivery` recovery actions (active plus recently resolved),
 * - queued replay wakes (`payload->>'issueId'` index),
 * - non-terminal runs carrying replay context (`contextSnapshot->>'issueId'`).
 *
 * The projection itself is pure and unit-tested separately.
 */
export function feedbackDeliveryCommentStateService(db: Db) {
  async function loadRecoveryActions(input: {
    companyId: string;
    issueId: string;
    resolvedSince: Date;
  }) {
    return db
      .select({
        id: issueRecoveryActions.id,
        kind: issueRecoveryActions.kind,
        cause: issueRecoveryActions.cause,
        status: issueRecoveryActions.status,
        fingerprint: issueRecoveryActions.fingerprint,
        evidence: issueRecoveryActions.evidence,
        attemptCount: issueRecoveryActions.attemptCount,
        maxAttempts: issueRecoveryActions.maxAttempts,
        previousOwnerAgentId: issueRecoveryActions.previousOwnerAgentId,
        lastAttemptAt: issueRecoveryActions.lastAttemptAt,
        resolvedAt: issueRecoveryActions.resolvedAt,
        createdAt: issueRecoveryActions.createdAt,
      })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, input.companyId),
          eq(issueRecoveryActions.sourceIssueId, input.issueId),
          eq(issueRecoveryActions.kind, FEEDBACK_DELIVERY_RECOVERY_ACTION_KIND),
          or(
            inArray(issueRecoveryActions.status, ["active", "escalated"]),
            gte(issueRecoveryActions.resolvedAt, input.resolvedSince),
          ),
        ),
      );
  }

  async function loadPendingReplays(input: {
    companyId: string;
    issueId: string;
  }): Promise<FeedbackDeliveryPendingReplay[]> {
    const [wakes, runs] = await Promise.all([
      db
        .select({
          agentId: agentWakeupRequests.agentId,
          payload: agentWakeupRequests.payload,
          runId: agentWakeupRequests.runId,
          requestedAt: agentWakeupRequests.requestedAt,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, input.companyId),
            inArray(agentWakeupRequests.status, [...PENDING_REPLAY_WAKE_STATUSES]),
            eq(agentWakeupRequests.reason, FEEDBACK_DELIVERY_RETRY_WAKE_REASON),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
          ),
        ),
      db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
          scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, input.companyId),
            inArray(heartbeatRuns.status, [...PENDING_REPLAY_RUN_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'feedbackDeliveryRootWakeupRequestId' is not null`,
          ),
        ),
    ]);

    const replays: FeedbackDeliveryPendingReplay[] = [];

    for (const wake of wakes) {
      const payload = readRecord(wake.payload);
      const rootWakeupRequestId = readReplayRootWakeupRequestId(payload);
      if (!rootWakeupRequestId) continue;
      replays.push({
        fingerprint: buildFeedbackDeliveryFingerprint({
          companyId: input.companyId,
          issueId: input.issueId,
          agentId: wake.agentId,
          rootWakeupRequestId,
        }),
        agentId: wake.agentId,
        commentIds: readReplayCommentIds(payload),
        generation: readGeneration(payload.feedbackDeliveryRetryGeneration),
        runId: wake.runId ?? null,
        nextAttemptAt: null,
        requestedAt: wake.requestedAt,
      });
    }

    for (const run of runs) {
      const context = readRecord(run.contextSnapshot);
      const rootWakeupRequestId = readReplayRootWakeupRequestId(context) ?? run.wakeupRequestId;
      if (!rootWakeupRequestId) continue;
      replays.push({
        fingerprint: buildFeedbackDeliveryFingerprint({
          companyId: input.companyId,
          issueId: input.issueId,
          agentId: run.agentId,
          rootWakeupRequestId,
        }),
        agentId: run.agentId,
        commentIds: readReplayCommentIds(context),
        generation: readGeneration(context.feedbackDeliveryRetryGeneration),
        runId: run.id,
        nextAttemptAt: run.scheduledRetryAt,
        requestedAt: run.createdAt,
      });
    }

    return replays;
  }

  return {
    /**
     * Returns a comment-id keyed map of delivery state, or an empty map when
     * this issue has no feedback-delivery history at all (the common case).
     */
    async listForIssue(input: {
      companyId: string;
      issueId: string;
      viewerCanRetry: boolean;
      viewerCanReadRuns: boolean;
      now?: Date;
    }): Promise<Map<string, IssueCommentFeedbackDelivery>> {
      const now = input.now ?? new Date();
      // Issued together: the first automatic replay is `retrying` *before* any
      // recovery action exists, so recovery actions cannot gate the replay read.
      // All three predicates are index-backed and scoped to one issue.
      const [recoveryActions, pendingReplays] = await Promise.all([
        loadRecoveryActions({
          companyId: input.companyId,
          issueId: input.issueId,
          resolvedSince: new Date(now.getTime() - FEEDBACK_DELIVERY_RECOVERED_WINDOW_MS),
        }),
        loadPendingReplays({ companyId: input.companyId, issueId: input.issueId }),
      ]);
      if (recoveryActions.length === 0 && pendingReplays.length === 0) return new Map();

      return projectFeedbackDeliveryByComment({
        recoveryActions,
        pendingReplays,
        viewerCanRetry: input.viewerCanRetry,
        viewerCanReadRuns: input.viewerCanReadRuns,
        now,
      });
    },
  };
}

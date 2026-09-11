import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueThreadInteractions,
} from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { evaluateIssueThreadInteractionResolverAudience } from "../issue-thread-interaction-resolution.js";

/**
 * Durable adjudication of the "executor is waiting on review/approval" premise.
 *
 * Saved continuation prose parks a queued continuation by asserting the
 * executor should wait for reviewer feedback or approval. Prose is not
 * authority: the same question has to be answered from the issue's durable
 * review state before a continuation is cancelled for it, and the answer has to
 * keep the exact-actor/current-head rules the interaction routes enforce:
 *
 * - exact actor: the resolution must have come from the actor the interaction
 *   was addressed to (or one the persisted resolver policy allows), and never
 *   from the reviewed evidence run itself,
 * - current head: only the newest review request in the issue's review-wait
 *   family counts. A newer pending request, or a newer non-accepted resolution,
 *   makes an older acceptance history rather than acceptance,
 * - never unrelated: only review/approval confirmation interactions with a
 *   wake-assignee continuation policy take part, so a question, suggestion, or
 *   verdict interaction can never clear a review park.
 *
 * A pending interaction of ANY kind — including a question or a verdict
 * request — deliberately reports `review_wait_open`: an open question is a real
 * human wait the executor must not bypass, so the park keeps holding until that
 * interaction is resolved. That is intentional gating, not an oversight.
 *
 * Ordering by `createdAt` is the generation fence (including A -> B -> A): a
 * replacement request created after an accepted one is the current head even
 * when it re-requests the same revision.
 */

export const REVIEW_WAIT_INTERACTION_KINDS = [
  "request_confirmation",
  "request_checkbox_confirmation",
] as const;

export const REVIEW_WAIT_CONTINUATION_POLICIES = [
  "wake_assignee",
  "wake_assignee_on_accept",
] as const;

const POSITIVE_RESOLUTION_STATUSES: Record<string, true> = {
  accepted: true,
  answered: true,
};

export type ReviewWaitInteractionRow = {
  id: string;
  kind: string;
  status: string;
  continuationPolicy: string;
  requestedResolverPolicy: string;
  effectiveResolverPolicy: string;
  resolverPolicyProvenance: string | null;
  addresseeAgentId: string | null;
  addresseeUserId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  resolvedByAgentId: string | null;
  resolvedByUserId: string | null;
  resolvedByRunId: string | null;
  sourceRunId: string | null;
  sourceRunAgentId: string | null;
  payload: unknown;
  resolvedAt: Date | null;
  createdAt: Date;
};

export type ReviewWaitState =
  | { kind: "accepted_current_review"; interaction: ReviewWaitInteractionRow }
  | {
      kind: "review_wait_open";
      reason: "pending_interaction" | "pending_approval";
      interactionId: string | null;
    }
  | { kind: "closed_review_not_accepted"; interactionId: string; status: string }
  | { kind: "non_authoritative_resolution"; interactionId: string; reason: string }
  | { kind: "no_review_interaction" };

/** The fresh lineage a superseded park resumes under. */
export type AcceptedReviewResume = {
  interactionId: string;
  resolvedAt: string;
  continuationPolicy: string;
  resolverKind: "agent" | "user" | "platform";
  resolvedByAgentId: string | null;
  resolvedByUserId: string | null;
  source: "queued_run_staleness_gate";
};

/**
 * Whether a stored resolution of a review/approval interaction exercised the
 * authority the interaction actually asked for. Rows written by the resolution
 * routes already passed this evaluator at decision time; replaying it here is
 * what keeps a direct or legacy write (a resolution recorded for the wrong
 * actor, or a run resolving its own governance) from clearing a park.
 */
export function isAuthoritativeReviewWaitResolution(input: {
  interaction: ReviewWaitInteractionRow;
}): { authoritative: boolean; reason: string } {
  const interaction = input.interaction;
  const payload = parseObject(interaction.payload);
  const governedAction = Boolean(payload.toolAction || payload.secretProposal);

  if (interaction.resolvedByUserId) {
    const decision = evaluateIssueThreadInteractionResolverAudience({
      actor: { type: "user", userId: interaction.resolvedByUserId },
      interaction,
      governedAction,
    });
    return decision.allowed
      ? { authoritative: true, reason: `allow_${decision.reason}` }
      : { authoritative: false, reason: decision.code };
  }

  if (interaction.resolvedByAgentId) {
    // A recorded resolution already passed the audience evaluator at write
    // time; a missing run id must not silently widen or block it. Mirror the
    // attention-owner convention: the creator is evaluated against the source
    // run (so creator exclusion still fires), everyone else against an opaque
    // non-source run.
    const recordedRunId = interaction.resolvedByRunId ??
      (interaction.createdByAgentId === interaction.resolvedByAgentId
        ? interaction.sourceRunId ?? "recorded-resolution-creator-run"
        : "recorded-resolution-non-source-run");
    const decision = evaluateIssueThreadInteractionResolverAudience({
      actor: {
        type: "agent",
        agentId: interaction.resolvedByAgentId,
        runId: recordedRunId,
      },
      interaction,
      governedAction,
    });
    if (!decision.allowed) return { authoritative: false, reason: decision.code };
    // Evidence reviewed by its own run cannot resolve the review. This holds
    // even when the row addresses that same agent: a legacy self-addressed
    // review resolved by the evidence run is self-review, exactly as the native
    // run finalizer treats it.
    if (
      interaction.sourceRunAgentId &&
      interaction.sourceRunAgentId === interaction.resolvedByAgentId
    ) {
      return { authoritative: false, reason: "interaction_self_review_denied" };
    }
    return { authoritative: true, reason: `allow_${decision.reason}` };
  }

  // No recorded resolver identity: platform-owned resolutions (supersession
  // sweeps, merged-pull-request confirmation) record no actor. They count only
  // for a positive resolution with a recorded time.
  if (!interaction.resolvedAt) return { authoritative: false, reason: "interaction_unresolved" };
  return { authoritative: true, reason: "allow_platform_resolution" };
}

/**
 * Exact-actor and current-head admissibility for using one accepted/answered
 * interaction as the issue's live continuation lineage. Non-review
 * interactions (questions, suggestions, verdicts) only need an authoritative
 * resolver; review-family interactions must additionally be the newest review
 * request in the issue's review-wait family.
 */
export function isCurrentAuthoritativeResolution(
  interaction: ReviewWaitInteractionRow,
  state: ReviewWaitState,
): { admissible: boolean; reason: string } {
  const authority = isAuthoritativeReviewWaitResolution({ interaction });
  if (!authority.authoritative) return { admissible: false, reason: authority.reason };
  const isReviewFamily = (REVIEW_WAIT_INTERACTION_KINDS as readonly string[]).includes(interaction.kind);
  if (!isReviewFamily) return { admissible: true, reason: "allow_non_review_interaction" };
  if (state.kind === "accepted_current_review" && state.interaction.id === interaction.id) {
    return { admissible: true, reason: "accepted_current_review" };
  }
  return { admissible: false, reason: `review_wait_${state.kind}` };
}

export function buildAcceptedReviewResume(
  interaction: ReviewWaitInteractionRow,
): AcceptedReviewResume {
  return {
    interactionId: interaction.id,
    resolvedAt: (interaction.resolvedAt ?? interaction.createdAt).toISOString(),
    continuationPolicy: interaction.continuationPolicy,
    resolverKind: interaction.resolvedByAgentId
      ? "agent"
      : interaction.resolvedByUserId
        ? "user"
        : "platform",
    resolvedByAgentId: interaction.resolvedByAgentId,
    resolvedByUserId: interaction.resolvedByUserId,
    source: "queued_run_staleness_gate",
  };
}

/**
 * Read the issue's durable review-wait state. Callers must not re-derive this
 * from saved prose or from the queued run's own context.
 */
export async function readReviewWaitState(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<ReviewWaitState> {
  const [pendingInteraction, pendingApproval, reviewRows] = await Promise.all([
    db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.status, "pending"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: approvals.id })
      .from(issueApprovals)
      .innerJoin(approvals, and(
        eq(issueApprovals.approvalId, approvals.id),
        eq(approvals.companyId, issueApprovals.companyId),
      ))
      .where(and(
        eq(issueApprovals.companyId, input.companyId),
        eq(issueApprovals.issueId, input.issueId),
        inArray(approvals.status, ["pending", "revision_requested"]),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: issueThreadInteractions.id,
        kind: issueThreadInteractions.kind,
        status: issueThreadInteractions.status,
        continuationPolicy: issueThreadInteractions.continuationPolicy,
        requestedResolverPolicy: issueThreadInteractions.requestedResolverPolicy,
        effectiveResolverPolicy: issueThreadInteractions.effectiveResolverPolicy,
        resolverPolicyProvenance: issueThreadInteractions.resolverPolicyProvenance,
        addresseeAgentId: issueThreadInteractions.addresseeAgentId,
        addresseeUserId: issueThreadInteractions.addresseeUserId,
        createdByAgentId: issueThreadInteractions.createdByAgentId,
        createdByUserId: issueThreadInteractions.createdByUserId,
        resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
        resolvedByUserId: issueThreadInteractions.resolvedByUserId,
        resolvedByRunId: issueThreadInteractions.resolvedByRunId,
        sourceRunId: issueThreadInteractions.sourceRunId,
        sourceRunAgentId: heartbeatRuns.agentId,
        payload: issueThreadInteractions.payload,
        resolvedAt: issueThreadInteractions.resolvedAt,
        createdAt: issueThreadInteractions.createdAt,
      })
      .from(issueThreadInteractions)
      .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, issueThreadInteractions.sourceRunId))
      .where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        inArray(issueThreadInteractions.kind, [...REVIEW_WAIT_INTERACTION_KINDS]),
        inArray(issueThreadInteractions.continuationPolicy, [...REVIEW_WAIT_CONTINUATION_POLICIES]),
      ))
      .orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id))
      .limit(6),
  ]);

  if (pendingInteraction) {
    return { kind: "review_wait_open", reason: "pending_interaction", interactionId: pendingInteraction.id };
  }
  if (pendingApproval) {
    return { kind: "review_wait_open", reason: "pending_approval", interactionId: pendingApproval.id };
  }

  const current = reviewRows[0] ?? null;
  if (!current) return { kind: "no_review_interaction" };
  if (current.status === "pending") {
    return { kind: "review_wait_open", reason: "pending_interaction", interactionId: current.id };
  }
  if (!POSITIVE_RESOLUTION_STATUSES[current.status]) {
    // The newest review request is rejected, expired, cancelled, or otherwise
    // non-positive: any accepted history before it is not the disposition now.
    return { kind: "closed_review_not_accepted", interactionId: current.id, status: current.status };
  }

  const authority = isAuthoritativeReviewWaitResolution({ interaction: current });
  if (!authority.authoritative) {
    return { kind: "non_authoritative_resolution", interactionId: current.id, reason: authority.reason };
  }
  return { kind: "accepted_current_review", interaction: current };
}

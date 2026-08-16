import type {
  IssueThreadInteractionCanonicalResolverPolicy,
  IssueThreadInteractionResolverPolicy,
} from "@paperclipai/shared";
import { normalizeIssueThreadInteractionResolverPolicy } from "@paperclipai/shared";
import { HttpError } from "../errors.js";

export const ISSUE_THREAD_INTERACTION_RESOLUTION_DENIAL_CODES = [
  "interaction_not_found",
  "interaction_run_attribution_required",
  "interaction_scope_denied",
  "interaction_human_only",
  "interaction_creator_excluded",
  "interaction_addressee_mismatch",
  "interaction_stale_target",
  "interaction_superseded",
  "interaction_already_resolved",
  "interaction_issue_closed",
  "interaction_governed_action_denied",
  "review_policy_denied",
] as const;

export type IssueThreadInteractionResolutionDenialCode =
  (typeof ISSUE_THREAD_INTERACTION_RESOLUTION_DENIAL_CODES)[number];

export type IssueThreadInteractionResolverActor =
  | { type: "user"; userId: string }
  | { type: "agent"; agentId: string | null | undefined; runId: string | null | undefined }
  | { type: "system"; systemId: string };

export type IssueThreadInteractionResolverRestriction = {
  policy: IssueThreadInteractionCanonicalResolverPolicy;
  /**
   * A server-resolved identity excluded by the binding flow in addition to the
   * interaction creator. `null` means the binding requires an identity but it
   * could not be resolved, so the evaluator must fail closed.
   */
  excludedActor?: { type: "agent" | "user"; id: string } | null;
  source?: "issue_review";
};

export type IssueThreadInteractionResolverAudienceInput = {
  actor: IssueThreadInteractionResolverActor;
  interaction: {
    createdByAgentId?: string | null;
    createdByUserId?: string | null;
    sourceRunId?: string | null;
    addresseeAgentId?: string | null;
    effectiveResolverPolicy: IssueThreadInteractionResolverPolicy | string;
    resolverPolicyProvenance?: string | null;
  };
  /**
   * A server-derived restriction owned by a binding flow such as issue review.
   * It may only narrow the interaction's persisted effective audience.
   */
  additionalRestriction?:
    | IssueThreadInteractionCanonicalResolverPolicy
    | IssueThreadInteractionResolverRestriction
    | null;
  governedAction?: boolean;
};

export type IssueThreadInteractionResolverAudienceDecision =
  | {
      allowed: true;
      effectiveResolverPolicy: IssueThreadInteractionCanonicalResolverPolicy;
      reason: "allow_anyone" | "allow_addressee" | "allow_human" | "allow_system" | "allow_human_override";
    }
  | {
      allowed: false;
      effectiveResolverPolicy: IssueThreadInteractionCanonicalResolverPolicy;
      status: 403 | 422;
      code: Extract<
        IssueThreadInteractionResolutionDenialCode,
        | "interaction_run_attribution_required"
        | "interaction_human_only"
        | "interaction_creator_excluded"
        | "interaction_addressee_mismatch"
        | "interaction_governed_action_denied"
        | "review_policy_denied"
      >;
      message: string;
      details?: Record<string, unknown>;
    };

/**
 * Canonicalize one stored resolver-policy value.
 *
 * Before provenance existed, `board_or_agents` excluded both the creator agent
 * and the creating run, so a pre-migration row must stay `not_creator` rather
 * than widening to canonical `anyone`. Every reader of the stored columns —
 * hydration, the audience evaluator, and the attention feed — goes through here
 * so none of them can disagree about a legacy row.
 */
export function canonicalizeStoredResolverPolicy(
  policy: IssueThreadInteractionResolverPolicy | string,
  resolverPolicyProvenance: string | null | undefined,
): IssueThreadInteractionCanonicalResolverPolicy {
  if (resolverPolicyProvenance === "legacy_inherited_restriction" && policy === "board_or_agents") {
    return "not_creator";
  }
  return normalizeIssueThreadInteractionResolverPolicy(policy as IssueThreadInteractionResolverPolicy);
}

function canonicalStoredPolicy(input: IssueThreadInteractionResolverAudienceInput["interaction"]) {
  return canonicalizeStoredResolverPolicy(
    input.effectiveResolverPolicy,
    input.resolverPolicyProvenance,
  );
}

function reviewRestrictionExcludesActor(
  restriction: IssueThreadInteractionResolverRestriction | null | undefined,
  actor: { type: "agent" | "user"; id: string },
) {
  return restriction?.policy === "not_creator"
    && restriction.source === "issue_review"
    && (
      restriction.excludedActor === null
      || (
        restriction.excludedActor?.type === actor.type
        && restriction.excludedActor.id === actor.id
      )
    );
}

function reviewPolicyDeniedDecision(
  effectiveResolverPolicy: IssueThreadInteractionCanonicalResolverPolicy,
  requesterKnown: boolean,
): Extract<IssueThreadInteractionResolverAudienceDecision, { allowed: false }> {
  return {
    allowed: false,
    effectiveResolverPolicy,
    status: 403,
    code: "review_policy_denied",
    message: requesterKnown
      ? "Review policy `not_creator` requires someone other than the writer who moved the issue into `in_review` to approve or reject it."
      : "Review policy `not_creator` requires a different writer, but the review requester could not be determined.",
    details: {
      policy: "not_creator",
      allowedActor: "writer_other_than_review_requester",
      remediation: requesterKnown
        ? "Have another writer with issue write access submit the verdict, or change reviewPolicy to `anyone`."
        : "Change reviewPolicy to `anyone`, or move the issue out of and back into `in_review` to record a requester before another writer submits the verdict.",
    },
  };
}

/**
 * The single pure audience evaluator for issue-thread interaction resolution.
 * Resource access, run validation, containment, and current-target checks must
 * happen before this evaluator. Mutation routes must re-run it at use time.
 */
export function evaluateIssueThreadInteractionResolverAudience(
  input: IssueThreadInteractionResolverAudienceInput,
): IssueThreadInteractionResolverAudienceDecision {
  const persistedPolicy = canonicalStoredPolicy(input.interaction);
  const additionalRestriction = typeof input.additionalRestriction === "string"
    ? { policy: input.additionalRestriction }
    : input.additionalRestriction;
  // human_only and not_creator are independent constraints, not a linear
  // severity scale: their intersection means "a human other than the
  // creator." Keep both predicates even though the persisted public policy
  // enum can only name one of them.
  const creatorExcluded =
    persistedPolicy === "not_creator"
    || additionalRestriction?.policy === "not_creator";
  const humanOnly =
    Boolean(input.governedAction)
    || persistedPolicy === "human_only"
    || additionalRestriction?.policy === "human_only";
  const effectiveResolverPolicy: IssueThreadInteractionCanonicalResolverPolicy = humanOnly
    ? "human_only"
    : creatorExcluded
      ? "not_creator"
      : "anyone";

  if (input.actor.type === "system") {
    return { allowed: true, effectiveResolverPolicy, reason: "allow_system" };
  }

  if (input.actor.type === "user") {
    if (
      creatorExcluded
      && input.interaction.createdByUserId === input.actor.userId
    ) {
      return {
        allowed: false,
        effectiveResolverPolicy,
        status: 403,
        code: "interaction_creator_excluded",
        message: "This issue-thread interaction requires a resolver other than its creator",
      };
    }
    if (reviewRestrictionExcludesActor(additionalRestriction, {
      type: "user",
      id: input.actor.userId,
    })) {
      return reviewPolicyDeniedDecision(
        effectiveResolverPolicy,
        additionalRestriction?.excludedActor !== null,
      );
    }
    return {
      allowed: true,
      effectiveResolverPolicy,
      reason: input.interaction.addresseeAgentId ? "allow_human_override" : "allow_human",
    };
  }

  if (!input.actor.agentId || !input.actor.runId?.trim()) {
    return {
      allowed: false,
      effectiveResolverPolicy,
      status: 422,
      code: "interaction_run_attribution_required",
      message: "A valid authenticated agent run is required to resolve this issue-thread interaction",
    };
  }

  if (input.governedAction) {
    return {
      allowed: false,
      effectiveResolverPolicy,
      status: 403,
      code: "interaction_governed_action_denied",
      message: "This interaction is bound to a governed action that requires independent authorization",
    };
  }

  if (effectiveResolverPolicy === "human_only") {
    return {
      allowed: false,
      effectiveResolverPolicy,
      status: 403,
      code: "interaction_human_only",
      message: "This issue-thread interaction is human-only",
    };
  }

  if (
    input.interaction.addresseeAgentId
    && input.interaction.addresseeAgentId !== input.actor.agentId
  ) {
    return {
      allowed: false,
      effectiveResolverPolicy,
      status: 403,
      code: "interaction_addressee_mismatch",
      message: "Only the addressed agent or an authorized human may resolve this issue-thread interaction",
    };
  }

  if (
    creatorExcluded
    && (
      input.interaction.createdByAgentId === input.actor.agentId
      || (
        Boolean(input.interaction.sourceRunId)
        && input.interaction.sourceRunId === input.actor.runId
      )
    )
  ) {
    return {
      allowed: false,
      effectiveResolverPolicy,
      status: 403,
      code: "interaction_creator_excluded",
      message: "This issue-thread interaction requires a resolver other than its creator or creating run",
    };
  }

  if (reviewRestrictionExcludesActor(additionalRestriction, {
    type: "agent",
    id: input.actor.agentId,
  })) {
    return reviewPolicyDeniedDecision(
      effectiveResolverPolicy,
      additionalRestriction?.excludedActor !== null,
    );
  }

  return {
    allowed: true,
    effectiveResolverPolicy,
    reason: input.interaction.addresseeAgentId ? "allow_addressee" : "allow_anyone",
  };
}

export function issueThreadInteractionResolutionError(
  status: number,
  code: IssueThreadInteractionResolutionDenialCode,
  message: string,
  details: Record<string, unknown> = {},
) {
  return new HttpError(status, message, { code, ...details });
}

export function assertIssueThreadInteractionResolverAudience(
  input: IssueThreadInteractionResolverAudienceInput,
) {
  const decision = evaluateIssueThreadInteractionResolverAudience(input);
  if (!decision.allowed) {
    throw issueThreadInteractionResolutionError(
      decision.status,
      decision.code,
      decision.message,
      { effectiveResolverPolicy: decision.effectiveResolverPolicy, ...(decision.details ?? {}) },
    );
  }
  return decision;
}

/**
 * Resolves agent-owned attention with the same audience rules used by mutation
 * routes. Run attribution is deliberately represented by the interaction's
 * source run for the creator and by an opaque non-source run for other agents;
 * the real run is still authenticated at mutation time.
 */
export function issueThreadInteractionAttentionAgentAllowed(input: {
  agentId: string;
  interaction: IssueThreadInteractionResolverAudienceInput["interaction"];
  additionalRestriction?: IssueThreadInteractionResolverAudienceInput["additionalRestriction"];
  governedAction?: boolean;
}) {
  const attentionRunId = input.interaction.createdByAgentId === input.agentId
    ? input.interaction.sourceRunId ?? "attention-owner-creator-run"
    : "attention-owner-non-source-run";
  return evaluateIssueThreadInteractionResolverAudience({
    actor: { type: "agent", agentId: input.agentId, runId: attentionRunId },
    interaction: input.interaction,
    additionalRestriction: input.additionalRestriction,
    governedAction: input.governedAction,
  }).allowed;
}

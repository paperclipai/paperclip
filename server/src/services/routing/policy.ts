import {
  REVIEWER_FAMILIES_FOR_WORKER,
  REVIEW_MANDATORY_TASK_CLASSES,
  ROUTING_POLICY_VERSION,
  taskFactsSchema,
  type AttemptRole,
  type ExecutionProfile,
  type ProviderFamily,
  type RouteAdvisorMode,
  type RouteDecisionParticipant,
  type RouteDecisionState,
  type RouteEscalationReason,
  type RouteReason,
  type RouteRevisionKind,
  type RouteRule,
  type TaskClass,
  type TaskFacts,
} from "@paperclipai/shared";

/**
 * The one deterministic routing module. It has no database, no clock, and no
 * model call: every input is an explicit fact, rule, profile, or counter, and
 * the same input always yields the same outcome. Everything that persists,
 * dispatches, or audits lives in `service.ts` and consumes this module.
 */

export type PolicyProfile = Pick<
  ExecutionProfile,
  "id" | "agentId" | "providerFamily" | "model" | "effort" | "roleCapabilities" | "enabled" | "maxConcurrentAttempts"
>;

export interface PreviousDecisionSnapshot {
  revisionKind: RouteRevisionKind;
  effectiveTaskClass: TaskClass;
  facts: TaskFacts | null;
  worker: RouteDecisionParticipant | null;
  requireCrossFamilyReview: boolean;
}

export interface RouteOverrideRequest {
  workerProfileId?: string;
  reviewerProfileId?: string | null;
  advisorProfileId?: string | null;
  requireCrossFamilyReview?: boolean;
}

export interface RoutePolicyInput {
  /** Raw facts; validated here so an invalid payload can never become a low-risk default. */
  facts: unknown;
  rules: readonly RouteRule[];
  profiles: readonly PolicyProfile[];
  /** Active writable/reviewer claims per profile id, used for deterministic pool selection. */
  activeClaimsByProfile: Readonly<Record<string, number>>;
  /** Profiles the caller has already found budget-blocked, paused, terminated, or otherwise non-invokable. */
  blockedProfileIds: readonly string[];
  /** Every agent that has authored an implementation attempt on this issue (worker or rescuer). */
  priorWorkerAgentIds: readonly string[];
  revisionKind: RouteRevisionKind;
  previous?: PreviousDecisionSnapshot | null;
  escalationReason?: RouteEscalationReason | null;
  override?: RouteOverrideRequest | null;
}

export interface RouteBounds {
  maxAttempts: number;
  maxWallClockMinutes: number;
  maxCostCents: number | null;
}

export interface RouteOutcome {
  policyVersion: string;
  state: RouteDecisionState;
  taskClass: TaskClass;
  effectiveTaskClass: TaskClass;
  facts: TaskFacts | null;
  worker: RouteDecisionParticipant | null;
  advisor: RouteDecisionParticipant | null;
  advisorMode: RouteAdvisorMode;
  reviewer: RouteDecisionParticipant | null;
  reviewerFallback: RouteDecisionParticipant | null;
  rescue: RouteDecisionParticipant | null;
  requireCrossFamilyReview: boolean;
  bounds: RouteBounds;
  reasonCodes: RouteReason[];
  escalationReason: RouteEscalationReason | null;
}

export interface ClassificationResult {
  effectiveTaskClass: TaskClass;
  reasonCodes: RouteReason[];
  /** Cross-layer or invariant scope that forces cross-family review even for optional-review classes. */
  forcesCrossFamilyReview: boolean;
}

const CONSERVATIVE_BOUNDS: RouteBounds = { maxAttempts: 1, maxWallClockMinutes: 60, maxCostCents: null };

const RISK_REASON: Record<TaskFacts["riskFlags"][number], RouteReason> = {
  auth: "security-sensitive",
  persistence: "persistent-schema",
  recovery: "recovery-invariant",
  concurrency: "concurrency-invariant",
  "destructive-mutation": "security-sensitive",
  "repository-identity": "security-sensitive",
  "multiple-authority-seams": "cross-layer",
};

const SECURITY_RISKS: Record<string, true> = {
  auth: true,
  "destructive-mutation": true,
  "repository-identity": true,
};

function pushUnique<T>(list: T[], value: T) {
  if (!list.includes(value)) list.push(value);
}

/**
 * Deterministic task-class promotion. Promotion only ever moves work toward a
 * more capable/critical class; it never downgrades a declared class.
 */
export function classifyFacts(facts: TaskFacts): ClassificationResult | { refusal: "classification-required"; reasonCodes: RouteReason[] } {
  const reasonCodes: RouteReason[] = [];
  for (const flag of facts.riskFlags) pushUnique(reasonCodes, RISK_REASON[flag]);
  const crossLayer = facts.affectedLayers.length >= 3 || facts.riskFlags.includes("multiple-authority-seams");
  if (crossLayer) pushUnique(reasonCodes, "cross-layer");
  if (facts.reproductionKnown && (facts.taskClass === "bug_fast" || facts.taskClass === "bug_invariant")) {
    pushUnique(reasonCodes, "known-reproduction");
  }
  const hasRisk = facts.riskFlags.length > 0;
  const hasSecurityRisk = facts.riskFlags.some((flag) => SECURITY_RISKS[flag] === true);
  const hasInvariantRisk = facts.riskFlags.includes("recovery") || facts.riskFlags.includes("concurrency");

  let effectiveTaskClass: TaskClass = facts.taskClass;
  switch (facts.taskClass) {
    case "feature_standard":
      if (hasRisk) effectiveTaskClass = "feature_critical";
      break;
    case "bug_fast":
      if (hasSecurityRisk) effectiveTaskClass = "security_recovery";
      else if (hasInvariantRisk || !facts.reproductionKnown || facts.architecturalDecisionOpen || hasRisk) {
        effectiveTaskClass = "bug_invariant";
      }
      break;
    case "bug_invariant":
      if (hasSecurityRisk) effectiveTaskClass = "security_recovery";
      break;
    case "mechanical":
      if (hasRisk) {
        effectiveTaskClass = hasSecurityRisk ? "security_recovery" : "feature_critical";
      } else if (!facts.acceptanceDefined || facts.architecturalDecisionOpen) {
        return { refusal: "classification-required", reasonCodes };
      } else {
        pushUnique(reasonCodes, "mechanical-cutover");
      }
      break;
    case "feature_critical":
    case "migration":
    case "security_recovery":
      break;
  }
  if (effectiveTaskClass === "migration") pushUnique(reasonCodes, "persistent-schema");
  return {
    effectiveTaskClass,
    reasonCodes,
    forcesCrossFamilyReview: crossLayer || hasRisk,
  };
}

function toParticipant(profile: PolicyProfile): RouteDecisionParticipant {
  return {
    profileId: profile.id,
    agentId: profile.agentId,
    providerFamily: profile.providerFamily,
    model: profile.model,
    effort: profile.effort,
  };
}

interface ProfileIndex {
  byId: Record<string, PolicyProfile>;
  ordered: PolicyProfile[];
}

function indexProfiles(profiles: readonly PolicyProfile[]): ProfileIndex {
  const byId: Record<string, PolicyProfile> = {};
  for (const profile of profiles) byId[profile.id] = profile;
  const ordered = [...profiles].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { byId, ordered };
}

function isEligible(
  profile: PolicyProfile | undefined,
  role: AttemptRole,
  blocked: readonly string[],
): profile is PolicyProfile {
  return Boolean(profile && profile.enabled && profile.roleCapabilities.includes(role) && !blocked.includes(profile.id));
}

/**
 * A shared pool is every enabled profile that is execution-compatible with the
 * designated profile (same family, model, and effort) and holds the role. The
 * designated profile is always a member. Members are ordered by id so two
 * concurrent routers observe the same order; capacity is a tie-breaker only —
 * final admission happens under the claim row lock in the service.
 */
export function selectPoolMember(
  designated: PolicyProfile,
  role: AttemptRole,
  index: ProfileIndex,
  activeClaimsByProfile: Readonly<Record<string, number>>,
  blocked: readonly string[],
  excludeAgentIds: readonly string[],
): PolicyProfile | null {
  const members = index.ordered.filter(
    (candidate) =>
      isEligible(candidate, role, blocked) &&
      candidate.providerFamily === designated.providerFamily &&
      candidate.model === designated.model &&
      candidate.effort === designated.effort &&
      !excludeAgentIds.includes(candidate.agentId),
  );
  if (members.length === 0) return null;
  const withCapacity = members.find(
    (candidate) => (activeClaimsByProfile[candidate.id] ?? 0) < candidate.maxConcurrentAttempts,
  );
  return withCapacity ?? members[0]!;
}

export function reviewerFamilyAllowed(workerFamily: ProviderFamily, reviewerFamily: ProviderFamily): boolean {
  return REVIEWER_FAMILIES_FOR_WORKER[workerFamily].includes(reviewerFamily);
}

type ReviewerSelection =
  | { reviewer: RouteDecisionParticipant; fallback: RouteDecisionParticipant | null }
  | { state: "reviewer-family-conflict" | "reviewer-unavailable" };

/**
 * Selects an independent reviewer. The reviewer must hold the role, be enabled
 * and unblocked, belong to an allowed opposite family, and must never be an
 * agent that authored any implementation attempt on this issue (including the
 * current worker). A fallback is consulted only when the rule allows it.
 */
export function selectReviewer(input: {
  worker: RouteDecisionParticipant;
  candidates: readonly string[];
  index: ProfileIndex;
  blocked: readonly string[];
  priorWorkerAgentIds: readonly string[];
  allowFallback: boolean;
}): ReviewerSelection {
  const excluded = [...input.priorWorkerAgentIds, input.worker.agentId];
  let sawFamilyConflict = false;
  const valid: RouteDecisionParticipant[] = [];
  const considered = input.allowFallback ? input.candidates : input.candidates.slice(0, 1);
  for (const candidateId of considered) {
    const profile = input.index.byId[candidateId];
    if (!isEligible(profile, "reviewer", input.blocked)) continue;
    if (excluded.includes(profile.agentId)) continue;
    if (!reviewerFamilyAllowed(input.worker.providerFamily, profile.providerFamily)) {
      sawFamilyConflict = true;
      continue;
    }
    valid.push(toParticipant(profile));
  }
  if (valid.length === 0) {
    return { state: sawFamilyConflict ? "reviewer-family-conflict" : "reviewer-unavailable" };
  }
  return { reviewer: valid[0]!, fallback: valid[1] ?? null };
}

function reviewRequired(rule: RouteRule, facts: TaskFacts, classification: ClassificationResult): boolean {
  if (REVIEW_MANDATORY_TASK_CLASSES[classification.effectiveTaskClass]) return true;
  if (classification.forcesCrossFamilyReview) return true;
  if (rule.reviewRequirement === "always") return true;
  if (rule.reviewRequirement === "consequential") return facts.consequential;
  return false;
}

function refusal(
  state: RouteDecisionState,
  facts: TaskFacts | null,
  taskClass: TaskClass,
  effectiveTaskClass: TaskClass,
  reasonCodes: RouteReason[],
  extra: Partial<RouteOutcome> = {},
): RouteOutcome {
  return {
    policyVersion: ROUTING_POLICY_VERSION,
    state,
    taskClass,
    effectiveTaskClass,
    facts,
    worker: null,
    advisor: null,
    advisorMode: "none",
    reviewer: null,
    reviewerFallback: null,
    rescue: null,
    requireCrossFamilyReview: true,
    bounds: CONSERVATIVE_BOUNDS,
    reasonCodes,
    escalationReason: null,
    ...extra,
  };
}

/**
 * Computes a route outcome. Returns a typed refusal state rather than throwing
 * so the service can persist every refusal as an auditable decision row.
 */
export function decideRoute(input: RoutePolicyInput): RouteOutcome {
  const parsed = taskFactsSchema.safeParse(input.facts);
  if (!parsed.success) {
    return refusal("classification-required", null, "feature_critical", "feature_critical", []);
  }
  const facts = parsed.data;
  const classified = classifyFacts(facts);
  if ("refusal" in classified) {
    return refusal(classified.refusal, facts, facts.taskClass, facts.taskClass, classified.reasonCodes);
  }
  const { effectiveTaskClass } = classified;
  const reasonCodes = [...classified.reasonCodes];
  const rule = input.rules.find((candidate) => candidate.taskClass === effectiveTaskClass) ?? null;
  if (!rule) {
    return refusal("no-capable-worker", facts, facts.taskClass, effectiveTaskClass, reasonCodes);
  }
  const index = indexProfiles(input.profiles);
  const blocked = input.blockedProfileIds;
  const bounds: RouteBounds = {
    maxAttempts: rule.maxAttempts,
    maxWallClockMinutes: rule.maxWallClockMinutes,
    maxCostCents: rule.maxCostCents,
  };
  const previousWorker = input.previous?.worker ?? null;
  const isRescue = input.revisionKind === "rescue";
  const escalationReason = input.escalationReason ?? null;

  if (isRescue) {
    pushUnique(reasonCodes, escalationReason === "architectural-review-rejection" ? "review-rejected" : "repeated-failure");
    if (input.previous?.revisionKind === "rescue") {
      return refusal("escalation-required", facts, facts.taskClass, effectiveTaskClass, reasonCodes, {
        escalationReason,
        bounds,
      });
    }
  }

  // Worker selection: override > rescue profile > rule worker; always through the shared pool.
  const workerRole: AttemptRole = isRescue ? "rescuer" : "worker";
  const designatedWorkerId = input.override?.workerProfileId ?? (isRescue ? rule.rescueProfileId : rule.workerProfileId);
  const designatedWorker = designatedWorkerId ? index.byId[designatedWorkerId] : undefined;
  const blockedForBudget = designatedWorker !== undefined && blocked.includes(designatedWorker.id);
  if (!isEligible(designatedWorker, workerRole, blocked)) {
    if (blockedForBudget) pushUnique(reasonCodes, "budget-limited");
    return refusal(
      isRescue ? "escalation-required" : blockedForBudget ? "budget-limited" : "no-capable-worker",
      facts,
      facts.taskClass,
      effectiveTaskClass,
      reasonCodes,
      { escalationReason, bounds },
    );
  }
  // A rescuer must change provider family and must not be a previous author.
  const excludeWorkerAgents = isRescue ? input.priorWorkerAgentIds : [];
  const workerProfile = selectPoolMember(
    designatedWorker,
    workerRole,
    index,
    input.activeClaimsByProfile,
    blocked,
    excludeWorkerAgents,
  );
  if (!workerProfile) {
    return refusal(isRescue ? "escalation-required" : "no-capable-worker", facts, facts.taskClass, effectiveTaskClass, reasonCodes, {
      escalationReason,
      bounds,
    });
  }
  const worker = toParticipant(workerProfile);

  // Advisor: bounded, read-only, never the worker itself.
  let advisorMode: RouteAdvisorMode = rule.advisorMode;
  let advisor: RouteDecisionParticipant | null = null;
  const advisorProfileId = input.override?.advisorProfileId === undefined ? rule.advisorProfileId : input.override.advisorProfileId;
  if (advisorMode !== "none" && advisorProfileId) {
    const profile = index.byId[advisorProfileId];
    if (isEligible(profile, "advisor", blocked) && profile.agentId !== worker.agentId) {
      advisor = toParticipant(profile);
    }
  }
  if (advisorMode === "required" && !advisor) {
    pushUnique(reasonCodes, "provider-unavailable");
    return refusal("escalation-required", facts, facts.taskClass, effectiveTaskClass, reasonCodes, { escalationReason, bounds });
  }
  if (!advisor) advisorMode = "none";

  // Review: mandatory floors cannot be waived by rules or overrides.
  const floorRequired = REVIEW_MANDATORY_TASK_CLASSES[effectiveTaskClass] || classified.forcesCrossFamilyReview;
  const requireCrossFamilyReview =
    floorRequired || (input.override?.requireCrossFamilyReview ?? reviewRequired(rule, facts, classified));
  let reviewer: RouteDecisionParticipant | null = null;
  let reviewerFallback: RouteDecisionParticipant | null = null;
  if (requireCrossFamilyReview) {
    const overrideReviewer = input.override?.reviewerProfileId;
    const ruleCandidates = [rule.reviewerProfileId, rule.reviewerFallbackProfileId].filter((id): id is string => Boolean(id));
    // A rescue or override that changes the worker's family invalidates the rule's
    // reviewer design, so every reviewer-capable profile of an allowed family is
    // considered after the rule's own candidates, in deterministic id order.
    const workerFamilyChanged = previousWorker !== null && previousWorker.providerFamily !== worker.providerFamily;
    const poolCandidates = workerFamilyChanged
      ? index.ordered.filter((profile) => profile.roleCapabilities.includes("reviewer")).map((profile) => profile.id)
      : [];
    const candidates = overrideReviewer ? [overrideReviewer] : [...ruleCandidates, ...poolCandidates];
    const selection = selectReviewer({
      worker,
      candidates,
      index,
      blocked,
      priorWorkerAgentIds: input.priorWorkerAgentIds,
      allowFallback: !overrideReviewer && (rule.reviewerFallbackPolicy === "fallback" || workerFamilyChanged),
    });
    if ("state" in selection) {
      return refusal(selection.state, facts, facts.taskClass, effectiveTaskClass, reasonCodes, {
        worker,
        advisor,
        advisorMode,
        requireCrossFamilyReview: true,
        escalationReason,
        bounds,
      });
    }
    reviewer = selection.reviewer;
    reviewerFallback = selection.fallback;
  }

  const rescueProfile = rule.rescueProfileId ? index.byId[rule.rescueProfileId] : undefined;
  const rescue = rescueProfile && rescueProfile.enabled && rescueProfile.roleCapabilities.includes("rescuer")
    ? toParticipant(rescueProfile)
    : null;

  return {
    policyVersion: ROUTING_POLICY_VERSION,
    state: "routed",
    taskClass: facts.taskClass,
    effectiveTaskClass,
    facts,
    worker,
    advisor,
    advisorMode,
    reviewer,
    reviewerFallback,
    rescue,
    requireCrossFamilyReview,
    bounds,
    reasonCodes,
    escalationReason,
  };
}

export interface EscalationSignals {
  sameFailureFingerprintCount?: number;
  architecturalReviewRejected?: boolean;
  terminalAttemptDirty?: boolean;
  verificationFailingAtTerminalAttempt?: boolean;
  scopeCrossedCriticalRisk?: boolean;
  noArtifactWithinWallClock?: boolean;
  noDurableActionPath?: boolean;
  repeatedCorrectionAgainstRejectedInvariant?: boolean;
  /** Not escalation triggers by themselves; listed so callers cannot smuggle them in. */
  singleTimeout?: boolean;
  formatterFailure?: boolean;
  compilerError?: boolean;
}

/** Typed escalation triggers. A single timeout, formatter failure, or compiler error never escalates alone. */
export function evaluateEscalation(signals: EscalationSignals): RouteEscalationReason | null {
  if ((signals.sameFailureFingerprintCount ?? 0) >= 2) return "repeated-failure-fingerprint";
  if (signals.architecturalReviewRejected) return "architectural-review-rejection";
  if (signals.repeatedCorrectionAgainstRejectedInvariant) return "repeated-correction-against-rejected-invariant";
  if (signals.scopeCrossedCriticalRisk) return "scope-crossed-critical-risk";
  if (signals.terminalAttemptDirty) return "dirty-terminal-attempt";
  if (signals.verificationFailingAtTerminalAttempt) return "verification-failing-at-terminal-attempt";
  if (signals.noArtifactWithinWallClock) return "no-artifact-within-wall-clock";
  if (signals.noDurableActionPath) return "no-durable-action-path";
  return null;
}

/** One ordinary advisor round per attempt; further requests must escalate instead of looping. */
export function canRequestAdvisorRound(
  decision: { advisorMode: RouteAdvisorMode; advisor: RouteDecisionParticipant | null },
  roundsUsedThisAttempt: number,
): boolean {
  return decision.advisorMode !== "none" && decision.advisor !== null && roundsUsedThisAttempt < 1;
}

/**
 * Authority separation on a materialized decision: no agent holds two roles on
 * the same attempt, and the reviewer never belongs to the worker's family.
 */
export function validateAuthoritySeparation(decision: {
  worker: RouteDecisionParticipant | null;
  advisor: RouteDecisionParticipant | null;
  reviewer: RouteDecisionParticipant | null;
}): string[] {
  const problems: string[] = [];
  const { worker, advisor, reviewer } = decision;
  if (worker && advisor && worker.agentId === advisor.agentId) problems.push("worker cannot advise itself");
  if (worker && reviewer && worker.agentId === reviewer.agentId) problems.push("worker cannot review itself");
  if (advisor && reviewer && advisor.agentId === reviewer.agentId) problems.push("advisor cannot also review");
  if (worker && reviewer && !reviewerFamilyAllowed(worker.providerFamily, reviewer.providerFamily)) {
    problems.push(`reviewer family ${reviewer.providerFamily} may not review ${worker.providerFamily}`);
  }
  return problems;
}

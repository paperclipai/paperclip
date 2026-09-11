import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  agents,
  executionProfiles,
  heartbeatRuns,
  issues,
  routeDecisions,
  routePoolClaims,
  routeRules,
  type Db,
} from "@paperclipai/db";
import {
  FAIL_CLOSED_TASK_CLASSES,
  TASK_CLASSES,
  type AttemptRole,
  type CreateExecutionProfileInput,
  type ExecutionProfile,
  type IssueRouting,
  type OverrideRouteInput,
  type ProviderFamily,
  type RouteDecision,
  type RouteDecisionParticipant,
  type RouteEscalationReason,
  type RoutePoolClaim,
  type RouteRule,
  type RouteRuleDefaultsBindingsInput,
  type RouteRuleDefaultsResult,
  type TaskClass,
  type TaskFacts,
  type UpdateExecutionProfileInput,
  type UpsertRouteRuleInput,
} from "@paperclipai/shared";
import { HttpError, conflict, notFound, unprocessable } from "../../errors.js";
import { logActivity } from "../activity-log.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { budgetService } from "../budgets.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { issueService } from "../issues.js";
import { redactSensitiveText } from "../../redaction.js";
import {
  decideRoute,
  reviewerFamilyAllowed,
  type PolicyProfile,
  type RouteOutcome,
  type RouteOverrideRequest,
} from "./policy.js";

export const ROUTE_REVIEW_ORIGIN_KIND = "route_review";
export const ROUTE_DECISION_RUN_EVENT_TYPE = "route.decision";
const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;
const LIVE_RUN_STATUSES = ["queued", "running"] as const;

export type RoutingActor = {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId: string | null;
  userId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
  responsibleUserId: string | null;
};

export const ROUTING_SYSTEM_ACTOR: RoutingActor = {
  actorType: "system",
  actorId: "task_attempt_routing",
  agentId: null,
  userId: null,
  runId: null,
  agentApiKeyId: null,
  responsibleUserId: null,
};

export type RoutingWakeup = (
  agentId: string,
  opts: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown>;
    contextSnapshot?: Record<string, unknown>;
    requestedByActorType?: "agent" | "user" | "system";
    requestedByActorId?: string | null;
    idempotencyKey?: string;
    issueStateGuard?: { statuses: string[]; assigneeAgentId: string };
  },
) => Promise<typeof heartbeatRuns.$inferSelect | null>;

export interface RoutingServiceDeps {
  enqueueWakeup?: RoutingWakeup | null;
}

type ProfileRow = typeof executionProfiles.$inferSelect;
type RuleRow = typeof routeRules.$inferSelect;
type DecisionRow = typeof routeDecisions.$inferSelect;
type ClaimRow = typeof routePoolClaims.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

export type DispatchResult =
  | { dispatched: true; decision: RouteDecision; claim: RoutePoolClaim; runId: string }
  | { dispatched: false; decision: RouteDecision; reason: "wake_rejected" };

export type ReviewRequestResult =
  | { state: "requested"; reviewIssueId: string; reviewer: RouteDecisionParticipant; created: boolean }
  | { state: "not-required"; decision: RouteDecision }
  | { state: "reviewer-unavailable"; decision: RouteDecision; blocked: boolean };

function toProfile(row: ProfileRow): ExecutionProfile {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    providerFamily: row.providerFamily as ProviderFamily,
    agentId: row.agentId,
    model: row.model,
    effort: row.effort,
    roleCapabilities: row.roleCapabilities as AttemptRole[],
    enabled: row.enabled,
    maxConcurrentAttempts: row.maxConcurrentAttempts,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRule(row: RuleRow): RouteRule {
  return {
    id: row.id,
    companyId: row.companyId,
    taskClass: row.taskClass as TaskClass,
    workerProfileId: row.workerProfileId,
    advisorProfileId: row.advisorProfileId,
    advisorMode: row.advisorMode as RouteRule["advisorMode"],
    reviewerProfileId: row.reviewerProfileId,
    reviewerFallbackProfileId: row.reviewerFallbackProfileId,
    reviewRequirement: row.reviewRequirement as RouteRule["reviewRequirement"],
    reviewerFallbackPolicy: row.reviewerFallbackPolicy as RouteRule["reviewerFallbackPolicy"],
    rescueProfileId: row.rescueProfileId,
    maxAttempts: row.maxAttempts,
    maxWallClockMinutes: row.maxWallClockMinutes,
    maxCostCents: row.maxCostCents,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function participantFromRow(
  row: DecisionRow,
  prefix: "worker" | "advisor" | "reviewer" | "reviewerFallback" | "rescue",
): RouteDecisionParticipant | null {
  const profileId = row[`${prefix}ProfileId`];
  const agentId = row[`${prefix}AgentId`];
  const providerFamily = row[`${prefix}ProviderFamily`];
  const model = row[`${prefix}Model`];
  const effort = row[`${prefix}Effort`];
  if (!profileId || !agentId || !providerFamily || !model || !effort) return null;
  return { profileId, agentId, providerFamily: providerFamily as ProviderFamily, model, effort };
}

function toDecision(row: DecisionRow): RouteDecision {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    revision: row.revision,
    supersedesDecisionId: row.supersedesDecisionId,
    revisionKind: row.revisionKind as RouteDecision["revisionKind"],
    policyVersion: row.policyVersion,
    taskClass: row.taskClass as TaskClass,
    effectiveTaskClass: row.effectiveTaskClass as TaskClass,
    facts: (row.facts as TaskFacts | null) ?? null,
    state: row.state as RouteDecision["state"],
    worker: participantFromRow(row, "worker"),
    advisor: participantFromRow(row, "advisor"),
    advisorMode: row.advisorMode as RouteDecision["advisorMode"],
    reviewer: participantFromRow(row, "reviewer"),
    reviewerFallback: participantFromRow(row, "reviewerFallback"),
    rescue: participantFromRow(row, "rescue"),
    requireCrossFamilyReview: row.requireCrossFamilyReview,
    maxAttempts: row.maxAttempts,
    maxWallClockMinutes: row.maxWallClockMinutes,
    maxCostCents: row.maxCostCents,
    reasonCodes: row.reasonCodes as RouteDecision["reasonCodes"],
    escalationReason: (row.escalationReason as RouteEscalationReason | null) ?? null,
    note: row.note,
    createdByType: row.createdByType as RouteDecision["createdByType"],
    createdByUserId: row.createdByUserId,
    createdByAgentId: row.createdByAgentId,
    createdAt: row.createdAt,
  };
}

function toClaim(row: ClaimRow): RoutePoolClaim {
  return {
    id: row.id,
    companyId: row.companyId,
    profileId: row.profileId,
    decisionId: row.decisionId,
    issueId: row.issueId,
    role: row.role as AttemptRole,
    runId: row.runId,
    claimedAt: row.claimedAt,
    releasedAt: row.releasedAt,
    releaseReason: row.releaseReason,
  };
}

type ParticipantPrefix = "worker" | "advisor" | "reviewer" | "reviewerFallback" | "rescue";
type ParticipantColumns<P extends ParticipantPrefix> = {
  [K in `${P}ProfileId` | `${P}AgentId` | `${P}ProviderFamily` | `${P}Model` | `${P}Effort`]: string | null;
};

function participantColumns<P extends ParticipantPrefix>(prefix: P, participant: RouteDecisionParticipant | null): ParticipantColumns<P> {
  // Computed template-literal keys cannot be inferred by TypeScript; the mapped
  // type above is the exact shape produced for every prefix.
  const columns = {
    [`${prefix}ProfileId`]: participant?.profileId ?? null,
    [`${prefix}AgentId`]: participant?.agentId ?? null,
    [`${prefix}ProviderFamily`]: participant?.providerFamily ?? null,
    [`${prefix}Model`]: participant?.model ?? null,
    [`${prefix}Effort`]: participant?.effort ?? null,
  } as ParticipantColumns<P>;
  return columns;
}

/** Public detail summary: ids, families, models and reason codes only — never config or errors. */
function decisionAuditDetails(decision: RouteDecision): Record<string, unknown> {
  return {
    decisionId: decision.id,
    revision: decision.revision,
    revisionKind: decision.revisionKind,
    supersedesDecisionId: decision.supersedesDecisionId,
    policyVersion: decision.policyVersion,
    state: decision.state,
    taskClass: decision.taskClass,
    effectiveTaskClass: decision.effectiveTaskClass,
    workerProfileId: decision.worker?.profileId ?? null,
    workerProviderFamily: decision.worker?.providerFamily ?? null,
    workerModel: decision.worker?.model ?? null,
    advisorProfileId: decision.advisor?.profileId ?? null,
    reviewerProfileId: decision.reviewer?.profileId ?? null,
    reviewerProviderFamily: decision.reviewer?.providerFamily ?? null,
    requireCrossFamilyReview: decision.requireCrossFamilyReview,
    reasonCodes: decision.reasonCodes,
    escalationReason: decision.escalationReason,
  };
}

export function routingService(db: Db, deps: RoutingServiceDeps = {}) {
  const issuesSvc = issueService(db);
  const budgets = budgetService(db);

  async function recordActivity(
    actor: RoutingActor,
    input: { companyId: string; action: string; entityType: string; entityId: string; issueId?: string | null; details?: Record<string, unknown> },
  ) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      responsibleUserIdOverride: actor.responsibleUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      issueId: input.issueId ?? null,
      details: input.details ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // Execution profiles
  // ---------------------------------------------------------------------------

  async function loadCompanyAgent(companyId: string, agentId: string) {
    const agent = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw unprocessable("Execution profile agent must belong to the company", { code: "agent_company_mismatch" });
    if (agent.status === "terminated") throw unprocessable("Terminated agents cannot back an execution profile", { code: "agent_terminated" });
    return agent;
  }

  function configuredAgentModel(agent: typeof agents.$inferSelect): string | null {
    const model = agent.adapterConfig.model;
    return typeof model === "string" && model.trim() ? model.trim() : null;
  }

  function assertProfileModelMatchesAgent(agent: typeof agents.$inferSelect, model: string) {
    const configured = configuredAgentModel(agent);
    if (configured && configured !== model) {
      throw unprocessable("Execution profile model must match the agent's configured model", {
        code: "execution_profile_model_mismatch",
        configuredModel: configured,
        requestedModel: model,
      });
    }
  }

  async function listProfiles(companyId: string): Promise<ExecutionProfile[]> {
    const rows = await db
      .select()
      .from(executionProfiles)
      .where(eq(executionProfiles.companyId, companyId))
      .orderBy(asc(executionProfiles.name));
    return rows.map(toProfile);
  }

  async function getProfile(profileId: string): Promise<ExecutionProfile | null> {
    const row = await db.select().from(executionProfiles).where(eq(executionProfiles.id, profileId)).then((rows) => rows[0] ?? null);
    return row ? toProfile(row) : null;
  }

  async function createProfile(companyId: string, input: CreateExecutionProfileInput, actor: RoutingActor): Promise<ExecutionProfile> {
    const agent = await loadCompanyAgent(companyId, input.agentId);
    assertProfileModelMatchesAgent(agent, input.model);
    const row = await db
      .insert(executionProfiles)
      .values({
        companyId,
        name: input.name,
        providerFamily: input.providerFamily,
        agentId: input.agentId,
        model: input.model,
        effort: input.effort,
        roleCapabilities: input.roleCapabilities,
        enabled: input.enabled ?? true,
        maxConcurrentAttempts: input.maxConcurrentAttempts ?? 1,
      })
      .returning()
      .then((rows) => rows[0]!)
      .catch((error: unknown) => {
        if (error instanceof Error && /execution_profiles_company_(name|agent)_uq/.test(error.message)) {
          throw conflict("An execution profile with this name or agent already exists", { code: "execution_profile_exists" });
        }
        throw error;
      });
    const profile = toProfile(row);
    await recordActivity(actor, {
      companyId,
      action: "execution_profile.created",
      entityType: "execution_profile",
      entityId: profile.id,
      details: { name: profile.name, providerFamily: profile.providerFamily, agentId: profile.agentId, model: profile.model, effort: profile.effort, roleCapabilities: profile.roleCapabilities },
    });
    return profile;
  }

  async function updateProfile(companyId: string, profileId: string, input: UpdateExecutionProfileInput, actor: RoutingActor): Promise<ExecutionProfile> {
    const current = await db
      .select()
      .from(executionProfiles)
      .where(and(eq(executionProfiles.id, profileId), eq(executionProfiles.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!current) throw notFound("Execution profile not found");
    if (current.version !== input.expectedVersion) {
      throw conflict("Execution profile version conflict", { code: "version_conflict", version: current.version });
    }
    const nextAgentId = input.agentId ?? current.agentId;
    const nextModel = input.model ?? current.model;
    const agent = await loadCompanyAgent(companyId, nextAgentId);
    assertProfileModelMatchesAgent(agent, nextModel);
    const { expectedVersion: _expected, ...patch } = input;
    const row = await db
      .update(executionProfiles)
      .set({ ...patch, version: current.version + 1, updatedAt: new Date() })
      .where(and(eq(executionProfiles.id, profileId), eq(executionProfiles.version, current.version)))
      .returning()
      .then((rows) => rows[0] ?? null)
      .catch((error: unknown) => {
        if (error instanceof Error && /execution_profiles_company_(name|agent)_uq/.test(error.message)) {
          throw conflict("An execution profile with this name or agent already exists", { code: "execution_profile_exists" });
        }
        throw error;
      });
    if (!row) throw conflict("Execution profile version conflict", { code: "version_conflict" });
    const profile = toProfile(row);
    await recordActivity(actor, {
      companyId,
      action: "execution_profile.updated",
      entityType: "execution_profile",
      entityId: profile.id,
      details: { changedFields: Object.keys(patch), version: profile.version, enabled: profile.enabled, roleCapabilities: profile.roleCapabilities },
    });
    return profile;
  }

  // ---------------------------------------------------------------------------
  // Route rules
  // ---------------------------------------------------------------------------

  async function listRules(companyId: string): Promise<RouteRule[]> {
    const rows = await db.select().from(routeRules).where(eq(routeRules.companyId, companyId)).orderBy(asc(routeRules.taskClass));
    return rows.map(toRule);
  }

  function assertRuleInvariants(input: Omit<UpsertRouteRuleInput, "expectedVersion">, profilesById: Record<string, ExecutionProfile>) {
    const require = (id: string | null, role: AttemptRole, label: string) => {
      if (!id) return null;
      const profile = profilesById[id];
      if (!profile) throw unprocessable(`${label} profile does not belong to this company`, { code: "profile_company_mismatch", profileId: id });
      if (!profile.roleCapabilities.includes(role)) {
        throw unprocessable(`${label} profile lacks the ${role} capability`, { code: "profile_capability_missing", profileId: id, role });
      }
      return profile;
    };
    const worker = require(input.workerProfileId, "worker", "Worker");
    require(input.advisorProfileId, "advisor", "Advisor");
    const reviewer = require(input.reviewerProfileId, "reviewer", "Reviewer");
    const fallback = require(input.reviewerFallbackProfileId, "reviewer", "Reviewer fallback");
    const rescue = require(input.rescueProfileId, "rescuer", "Rescue");
    for (const candidate of [reviewer, fallback]) {
      if (worker && candidate && !reviewerFamilyAllowed(worker.providerFamily, candidate.providerFamily)) {
        throw unprocessable(`Reviewer family ${candidate.providerFamily} may not review ${worker.providerFamily} workers`, {
          code: "reviewer-family-conflict",
          workerProviderFamily: worker.providerFamily,
          reviewerProviderFamily: candidate.providerFamily,
        });
      }
      if (worker && candidate && candidate.agentId === worker.agentId) {
        throw unprocessable("A worker agent cannot review its own attempts", { code: "reviewer-self-review" });
      }
    }
    if (worker && rescue && rescue.agentId === worker.agentId) {
      throw unprocessable("A rescue profile must be a different executor than the worker", { code: "rescue-self-conflict" });
    }
  }

  async function upsertRule(companyId: string, input: UpsertRouteRuleInput, actor: RoutingActor): Promise<{ rule: RouteRule; created: boolean }> {
    const profiles = await listProfiles(companyId);
    const profilesById: Record<string, ExecutionProfile> = {};
    for (const profile of profiles) profilesById[profile.id] = profile;
    const { expectedVersion, ...fields } = input;
    assertRuleInvariants(fields, profilesById);
    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(routeRules)
        .where(and(eq(routeRules.companyId, companyId), eq(routeRules.taskClass, input.taskClass)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (existing) {
        if (expectedVersion != null && existing.version !== expectedVersion) {
          throw conflict("Route rule version conflict", { code: "version_conflict", version: existing.version });
        }
        const row = await tx
          .update(routeRules)
          .set({ ...fields, version: existing.version + 1, updatedAt: new Date() })
          .where(and(eq(routeRules.id, existing.id), eq(routeRules.version, existing.version)))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!row) throw conflict("Route rule version conflict", { code: "version_conflict" });
        return { row, created: false };
      }
      const row = await tx.insert(routeRules).values({ companyId, ...fields }).returning().then((rows) => rows[0]!);
      return { row, created: true };
    });
    const rule = toRule(result.row);
    await recordActivity(actor, {
      companyId,
      action: result.created ? "route_rule.created" : "route_rule.updated",
      entityType: "route_rule",
      entityId: rule.id,
      details: { taskClass: rule.taskClass, workerProfileId: rule.workerProfileId, reviewerProfileId: rule.reviewerProfileId, reviewerFallbackProfileId: rule.reviewerFallbackProfileId, rescueProfileId: rule.rescueProfileId, advisorProfileId: rule.advisorProfileId, advisorMode: rule.advisorMode, reviewRequirement: rule.reviewRequirement, reviewerFallbackPolicy: rule.reviewerFallbackPolicy, version: rule.version },
    });
    return { rule, created: result.created };
  }

  /**
   * Seeds the initial policy matrix from explicit operator bindings. Existing
   * rules are never overwritten; classes that cannot be expressed with the
   * supplied bindings are reported as unresolved.
   */
  async function applyDefaultRules(companyId: string, bindings: RouteRuleDefaultsBindingsInput, actor: RoutingActor): Promise<RouteRuleDefaultsResult> {
    const b = bindings;
    const base = { expectedVersion: null, maxCostCents: null } as const;
    const failClosed = (taskClass: TaskClass) => (FAIL_CLOSED_TASK_CLASSES[taskClass] ? "fail_closed" : "fallback") as UpsertRouteRuleInput["reviewerFallbackPolicy"];
    const definitions: UpsertRouteRuleInput[] = [
      { ...base, taskClass: "feature_standard", workerProfileId: b.longFeatureOwnerProfileId, advisorProfileId: null, advisorMode: "none", reviewerProfileId: b.invariantSpecialistProfileId, reviewerFallbackProfileId: b.advisorReviewerProfileId, reviewRequirement: "always", reviewerFallbackPolicy: failClosed("feature_standard"), rescueProfileId: b.invariantSpecialistProfileId, maxAttempts: 2, maxWallClockMinutes: 240 },
      { ...base, taskClass: "feature_critical", workerProfileId: b.longFeatureOwnerProfileId, advisorProfileId: b.advisorReviewerProfileId, advisorMode: "required", reviewerProfileId: b.invariantSpecialistProfileId, reviewerFallbackProfileId: null, reviewRequirement: "always", reviewerFallbackPolicy: failClosed("feature_critical"), rescueProfileId: b.invariantSpecialistProfileId, maxAttempts: 2, maxWallClockMinutes: 240 },
      { ...base, taskClass: "migration", workerProfileId: b.longFeatureOwnerProfileId, advisorProfileId: b.advisorReviewerProfileId, advisorMode: "optional", reviewerProfileId: b.invariantSpecialistProfileId, reviewerFallbackProfileId: null, reviewRequirement: "always", reviewerFallbackPolicy: failClosed("migration"), rescueProfileId: b.invariantSpecialistProfileId, maxAttempts: 2, maxWallClockMinutes: 240 },
      { ...base, taskClass: "bug_fast", workerProfileId: b.fastBugWorkerProfileId, advisorProfileId: null, advisorMode: "none", reviewerProfileId: b.advisorReviewerProfileId, reviewerFallbackProfileId: b.invariantSpecialistProfileId, reviewRequirement: "consequential", reviewerFallbackPolicy: failClosed("bug_fast"), rescueProfileId: b.longFeatureOwnerProfileId, maxAttempts: 2, maxWallClockMinutes: 90 },
      { ...base, taskClass: "bug_invariant", workerProfileId: b.invariantSpecialistProfileId, advisorProfileId: b.longFeatureOwnerProfileId, advisorMode: "optional", reviewerProfileId: b.fastBugWorkerProfileId, reviewerFallbackProfileId: b.longFeatureOwnerProfileId, reviewRequirement: "always", reviewerFallbackPolicy: failClosed("bug_invariant"), rescueProfileId: b.longFeatureOwnerProfileId, maxAttempts: 2, maxWallClockMinutes: 240 },
      { ...base, taskClass: "security_recovery", workerProfileId: b.invariantSpecialistProfileId, advisorProfileId: b.longFeatureOwnerProfileId, advisorMode: "required", reviewerProfileId: b.fastBugWorkerProfileId, reviewerFallbackProfileId: b.longFeatureOwnerProfileId, reviewRequirement: "always", reviewerFallbackPolicy: failClosed("security_recovery"), rescueProfileId: b.longFeatureOwnerProfileId, maxAttempts: 2, maxWallClockMinutes: 240 },
      { ...base, taskClass: "mechanical", workerProfileId: b.mechanicalPoolProfileId ?? null, advisorProfileId: null, advisorMode: "none", reviewerProfileId: b.fastBugWorkerProfileId, reviewerFallbackProfileId: b.invariantSpecialistProfileId, reviewRequirement: "consequential", reviewerFallbackPolicy: failClosed("mechanical"), rescueProfileId: b.longFeatureOwnerProfileId, maxAttempts: 1, maxWallClockMinutes: 60 },
    ];
    const existing = await listRules(companyId);
    const existingByClass: Record<string, RouteRule> = {};
    for (const rule of existing) existingByClass[rule.taskClass] = rule;
    const rules: RouteRule[] = [];
    const unresolvedTaskClasses: TaskClass[] = [];
    for (const definition of definitions) {
      const current = existingByClass[definition.taskClass];
      if (current) {
        rules.push(current);
        continue;
      }
      if (!definition.workerProfileId) {
        unresolvedTaskClasses.push(definition.taskClass);
        continue;
      }
      rules.push((await upsertRule(companyId, definition, actor)).rule);
    }
    return { rules, unresolvedTaskClasses };
  }

  // ---------------------------------------------------------------------------
  // Decisions
  // ---------------------------------------------------------------------------

  async function loadIssue(issueId: string): Promise<IssueRow> {
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");
    return issue;
  }

  async function listDecisionRows(companyId: string, issueId: string): Promise<DecisionRow[]> {
    return db
      .select()
      .from(routeDecisions)
      .where(and(eq(routeDecisions.companyId, companyId), eq(routeDecisions.issueId, issueId)))
      .orderBy(desc(routeDecisions.revision));
  }

  async function listActiveClaimRows(companyId: string, issueId?: string): Promise<ClaimRow[]> {
    const where = issueId
      ? and(eq(routePoolClaims.companyId, companyId), eq(routePoolClaims.issueId, issueId), isNull(routePoolClaims.releasedAt))
      : and(eq(routePoolClaims.companyId, companyId), isNull(routePoolClaims.releasedAt));
    return db.select().from(routePoolClaims).where(where).orderBy(asc(routePoolClaims.claimedAt));
  }

  /** Releases claims whose linked run has reached a terminal status. Time never releases a claim. */
  async function reconcileClaims(companyId: string, issueId?: string): Promise<number> {
    const active = await listActiveClaimRows(companyId, issueId);
    const runIds = active.map((claim) => claim.runId).filter((id): id is string => Boolean(id));
    if (runIds.length === 0) return 0;
    const terminalRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(inArray(heartbeatRuns.id, runIds), inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES])));
    let released = 0;
    for (const run of terminalRuns) {
      const rows = await db
        .update(routePoolClaims)
        .set({ releasedAt: new Date(), releaseReason: `run_${run.status}` })
        .where(and(eq(routePoolClaims.runId, run.id), isNull(routePoolClaims.releasedAt)))
        .returning();
      released += rows.length;
    }
    return released;
  }

  /** Profiles whose agent cannot be dispatched now: paused/terminated/org-chain invalid or budget-blocked. */
  async function blockedProfileIds(companyId: string, profiles: ExecutionProfile[], context: { issueId: string; projectId: string | null }): Promise<string[]> {
    const blocked: string[] = [];
    for (const profile of profiles) {
      if (!profile.enabled) continue;
      const agent = await db.select().from(agents).where(eq(agents.id, profile.agentId)).then((rows) => rows[0] ?? null);
      const invokability = await evaluateAgentInvokabilityFromDb(db, agent);
      if (!invokability.invokable) {
        blocked.push(profile.id);
        continue;
      }
      const budgetBlock = await budgets.getInvocationBlock(companyId, profile.agentId, context);
      if (budgetBlock) blocked.push(profile.id);
    }
    return blocked;
  }

  async function policyContext(issue: IssueRow) {
    const [profiles, rules, claims] = await Promise.all([
      listProfiles(issue.companyId),
      listRules(issue.companyId),
      listActiveClaimRows(issue.companyId),
    ]);
    const activeClaimsByProfile: Record<string, number> = {};
    for (const claim of claims) activeClaimsByProfile[claim.profileId] = (activeClaimsByProfile[claim.profileId] ?? 0) + 1;
    const blocked = await blockedProfileIds(issue.companyId, profiles, { issueId: issue.id, projectId: issue.projectId });
    const policyProfiles: PolicyProfile[] = profiles;
    return { profiles: policyProfiles, rules, activeClaimsByProfile, blocked };
  }

  function priorWorkerAgentIds(history: DecisionRow[]): string[] {
    const ids: string[] = [];
    for (const row of history) {
      if (row.workerAgentId && !ids.includes(row.workerAgentId)) ids.push(row.workerAgentId);
    }
    return ids;
  }

  /**
   * Appends a decision revision under the issue row lock. The lock serializes
   * every revision writer; the unique (company, issue, revision) index is the
   * final backstop. `expectedRevision` fences overrides.
   */
  async function appendDecision(input: {
    issue: IssueRow;
    outcome: RouteOutcome;
    revisionKind: RouteDecision["revisionKind"];
    actor: RoutingActor;
    note: string | null;
    expectedRevision?: number | null;
  }): Promise<{ decision: RouteDecision; previous: RouteDecision | null }> {
    const { issue, outcome, actor } = input;
    return db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from ${issues} where ${issues.id} = ${issue.id} for update`);
      const current = await tx
        .select()
        .from(routeDecisions)
        .where(and(eq(routeDecisions.companyId, issue.companyId), eq(routeDecisions.issueId, issue.id)))
        .orderBy(desc(routeDecisions.revision))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (input.expectedRevision != null && (current?.revision ?? 0) !== input.expectedRevision) {
        throw conflict("Route decision revision conflict", {
          code: "route_revision_conflict",
          currentRevision: current?.revision ?? 0,
          expectedRevision: input.expectedRevision,
        });
      }
      if (input.revisionKind !== "initial" && !current) {
        throw conflict("Issue has no route decision to revise", { code: "route_decision_missing" });
      }
      if (input.revisionKind === "initial" && current) {
        throw conflict("Issue already has a route decision", { code: "route_decision_exists", currentRevision: current.revision });
      }
      const row = await tx
        .insert(routeDecisions)
        .values({
          companyId: issue.companyId,
          issueId: issue.id,
          revision: (current?.revision ?? 0) + 1,
          supersedesDecisionId: current?.id ?? null,
          revisionKind: input.revisionKind,
          policyVersion: outcome.policyVersion,
          taskClass: outcome.taskClass,
          effectiveTaskClass: outcome.effectiveTaskClass,
          facts: outcome.facts ? { ...outcome.facts } : null,
          state: outcome.state,
          ...participantColumns("worker", outcome.worker),
          ...participantColumns("advisor", outcome.advisor),
          advisorMode: outcome.advisorMode,
          ...participantColumns("reviewer", outcome.reviewer),
          ...participantColumns("reviewerFallback", outcome.reviewerFallback),
          ...participantColumns("rescue", outcome.rescue),
          requireCrossFamilyReview: outcome.requireCrossFamilyReview,
          maxAttempts: outcome.bounds.maxAttempts,
          maxWallClockMinutes: outcome.bounds.maxWallClockMinutes,
          maxCostCents: outcome.bounds.maxCostCents,
          reasonCodes: outcome.reasonCodes,
          escalationReason: outcome.escalationReason,
          note: input.note ? redactSensitiveText(input.note) : null,
          createdByType: actor.actorType,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          createdByAgentId: actor.actorType === "agent" ? actor.agentId : null,
        })
        .returning()
        .then((rows) => rows[0]!);
      return { decision: toDecision(row), previous: current ? toDecision(current) : null };
    });
  }

  async function getCurrentDecision(companyId: string, issueId: string): Promise<RouteDecision | null> {
    const rows = await listDecisionRows(companyId, issueId);
    return rows[0] ? toDecision(rows[0]) : null;
  }

  async function findActiveReviewIssue(companyId: string, decisionId: string) {
    return db
      .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, ROUTE_REVIEW_ORIGIN_KIND),
        eq(issues.originId, decisionId),
        isNull(issues.hiddenAt),
        sql`${issues.status} not in ('done', 'cancelled')`,
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function getIssueRouting(issueId: string): Promise<IssueRouting> {
    const issue = await loadIssue(issueId);
    await reconcileClaims(issue.companyId, issue.id);
    const [rows, claims] = await Promise.all([listDecisionRows(issue.companyId, issue.id), listActiveClaimRows(issue.companyId, issue.id)]);
    const history = rows.map(toDecision);
    const current = history[0] ?? null;
    const reviewIssue = current ? await findActiveReviewIssue(issue.companyId, current.id) : null;
    const advisorRoundsUsed = current
      ? await db
          .select({ count: sql<number>`count(*)::int` })
          .from(routePoolClaims)
          .where(and(eq(routePoolClaims.decisionId, current.id), eq(routePoolClaims.role, "advisor")))
          .then((rows) => rows[0]?.count ?? 0)
      : 0;
    return {
      issueId: issue.id,
      current,
      history,
      activeClaims: claims.map(toClaim),
      reviewIssueId: reviewIssue?.id ?? null,
      advisorRoundsUsed,
    };
  }

  /**
   * Routes an issue from validated facts. An existing routed decision is
   * returned unchanged (ordinary retries keep the same immutable decision); a
   * refused decision may be re-routed with new facts as a `fallback` revision.
   */
  async function routeIssue(issueId: string, facts: unknown, actor: RoutingActor): Promise<{ decision: RouteDecision; created: boolean }> {
    const issue = await loadIssue(issueId);
    const current = await getCurrentDecision(issue.companyId, issue.id);
    if (current && current.state === "routed") return { decision: current, created: false };
    const context = await policyContext(issue);
    const history = await listDecisionRows(issue.companyId, issue.id);
    const revisionKind = current ? "fallback" : "initial";
    const outcome = decideRoute({
      facts,
      rules: context.rules,
      profiles: context.profiles,
      activeClaimsByProfile: context.activeClaimsByProfile,
      blockedProfileIds: context.blocked,
      priorWorkerAgentIds: priorWorkerAgentIds(history),
      revisionKind,
      previous: current ? { revisionKind: current.revisionKind, effectiveTaskClass: current.effectiveTaskClass, facts: current.facts, worker: current.worker, requireCrossFamilyReview: current.requireCrossFamilyReview } : null,
    });
    const { decision } = await appendDecision({ issue, outcome, revisionKind, actor, note: null });
    await recordActivity(actor, {
      companyId: issue.companyId,
      action: "route_decision.created",
      entityType: "route_decision",
      entityId: decision.id,
      issueId: issue.id,
      details: decisionAuditDetails(decision),
    });
    return { decision, created: true };
  }

  async function liveRunForIssue(issue: IssueRow): Promise<string | null> {
    const runIds = [issue.checkoutRunId, issue.executionRunId].filter((id): id is string => Boolean(id));
    if (runIds.length === 0) return null;
    const live = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(inArray(heartbeatRuns.id, runIds), inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES])))
      .then((rows) => rows[0] ?? null);
    return live?.id ?? null;
  }

  /** Claims one slot under the profile row lock; capacity can never be exceeded by concurrent claimants. */
  async function claimSlot(input: { companyId: string; profileId: string; decisionId: string; issueId: string; role: AttemptRole }): Promise<RoutePoolClaim> {
    return db.transaction(async (tx) => {
      const profile = await tx
        .select()
        .from(executionProfiles)
        .where(and(eq(executionProfiles.id, input.profileId), eq(executionProfiles.companyId, input.companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!profile) throw notFound("Execution profile not found");
      if (!profile.enabled) throw conflict("Execution profile is disabled", { code: "execution_profile_disabled", profileId: profile.id });
      const active = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(routePoolClaims)
        .where(and(eq(routePoolClaims.profileId, profile.id), isNull(routePoolClaims.releasedAt)))
        .then((rows) => rows[0]?.count ?? 0);
      if (active >= profile.maxConcurrentAttempts) {
        throw conflict("Execution profile has no free slot", {
          code: "pool_capacity_exhausted",
          profileId: profile.id,
          activeClaims: active,
          maxConcurrentAttempts: profile.maxConcurrentAttempts,
        });
      }
      const row = await tx
        .insert(routePoolClaims)
        .values({ companyId: input.companyId, profileId: profile.id, decisionId: input.decisionId, issueId: input.issueId, role: input.role })
        .returning()
        .then((rows) => rows[0]!)
        .catch((error: unknown) => {
          if (error instanceof Error && /route_pool_claims_active_(issue_role|writable_issue)_uq/.test(error.message)) {
            throw conflict("Issue already holds an active attempt claim", { code: "attempt_claim_active", role: input.role });
          }
          throw error;
        });
      return toClaim(row);
    });
  }

  async function releaseClaim(claimId: string, reason: string): Promise<void> {
    await db
      .update(routePoolClaims)
      .set({ releasedAt: new Date(), releaseReason: reason })
      .where(and(eq(routePoolClaims.id, claimId), isNull(routePoolClaims.releasedAt)));
  }

  async function releaseIssueClaim(issueId: string, role: AttemptRole, reason: string, actor: RoutingActor): Promise<RoutePoolClaim | null> {
    const issue = await loadIssue(issueId);
    const row = await db
      .update(routePoolClaims)
      .set({ releasedAt: new Date(), releaseReason: reason })
      .where(and(eq(routePoolClaims.companyId, issue.companyId), eq(routePoolClaims.issueId, issue.id), eq(routePoolClaims.role, role), isNull(routePoolClaims.releasedAt)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (row) {
      await recordActivity(actor, {
        companyId: issue.companyId,
        action: "route_claim.released",
        entityType: "route_pool_claim",
        entityId: row.id,
        issueId: issue.id,
        details: { role, reason, profileId: row.profileId, decisionId: row.decisionId },
      });
    }
    return row ? toClaim(row) : null;
  }

  async function assertNoModelDrift(participant: RouteDecisionParticipant) {
    const agent = await db.select().from(agents).where(eq(agents.id, participant.agentId)).then((rows) => rows[0] ?? null);
    if (!agent) throw conflict("Routed agent no longer exists", { code: "route_agent_missing", agentId: participant.agentId });
    const configured = configuredAgentModel(agent);
    if (configured && configured !== participant.model) {
      throw conflict("Routed agent model drifted from the decision snapshot; create a new revision", {
        code: "execution_profile_model_drift",
        decisionModel: participant.model,
        configuredModel: configured,
      });
    }
    return agent;
  }

  async function appendRouteRunEvent(run: { id: string; companyId: string; agentId: string }, decision: RouteDecision, role: AttemptRole) {
    await appendHeartbeatRunEvent(db, {
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      eventType: ROUTE_DECISION_RUN_EVENT_TYPE,
      stream: "system",
      level: "info",
      message: `Route decision ${decision.revision} (${decision.effectiveTaskClass}) dispatched as ${role}`,
      payload: { ...decisionAuditDetails(decision), role },
    });
  }

  /**
   * Dispatches the current routed decision: claims a pool slot, assigns the
   * worker agent, and wakes it through the existing heartbeat machinery with
   * the decision identity in the run context. Never dispatches over a live run.
   */
  async function dispatch(issueId: string, actor: RoutingActor): Promise<DispatchResult> {
    const issue = await loadIssue(issueId);
    await reconcileClaims(issue.companyId, issue.id);
    const decision = await getCurrentDecision(issue.companyId, issue.id);
    if (!decision) throw conflict("Issue has no route decision", { code: "route_decision_missing" });
    if (decision.state !== "routed" || !decision.worker) {
      throw conflict(`Route decision is ${decision.state}; it cannot be dispatched`, { code: decision.state, decisionId: decision.id });
    }
    if (issue.status === "done" || issue.status === "cancelled") {
      throw conflict("Terminal issues cannot be dispatched", { code: "issue_terminal", status: issue.status });
    }
    const liveRunId = await liveRunForIssue(issue);
    if (liveRunId) throw conflict("Issue already has a live attempt", { code: "attempt_active", runId: liveRunId });
    const enqueueWakeup = deps.enqueueWakeup;
    if (!enqueueWakeup) throw conflict("Routing dispatch is not wired to the heartbeat scheduler", { code: "dispatch_unavailable" });
    const workerAgent = await assertNoModelDrift(decision.worker);
    const role: AttemptRole = decision.revisionKind === "rescue" ? "rescuer" : "worker";
    const claim = await claimSlot({ companyId: issue.companyId, profileId: decision.worker.profileId, decisionId: decision.id, issueId: issue.id, role });
    try {
      if (issue.assigneeAgentId !== workerAgent.id || issue.assigneeUserId) {
        await issuesSvc.update(issue.id, {
          assigneeAgentId: workerAgent.id,
          assigneeUserId: null,
          ...(issue.status === "backlog" ? { status: "todo" } : {}),
          actorAgentId: actor.actorType === "agent" ? actor.agentId : null,
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
        });
      } else if (issue.status === "backlog") {
        await issuesSvc.update(issue.id, { status: "todo", actorUserId: actor.actorType === "user" ? actor.actorId : null });
      }
      const run = await enqueueWakeup(workerAgent.id, {
        source: "assignment",
        triggerDetail: "system",
        reason: "route_dispatch",
        payload: { issueId: issue.id, routeDecisionId: decision.id, routeRole: role },
        contextSnapshot: {
          issueId: issue.id,
          taskId: issue.id,
          source: "routing.dispatch",
          routeDecisionId: decision.id,
          routeRevision: decision.revision,
          routePolicyVersion: decision.policyVersion,
          executionProfileId: decision.worker.profileId,
          routeRole: role,
          routeTaskClass: decision.effectiveTaskClass,
        },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        idempotencyKey: `route:${decision.id}:${claim.id}`,
        issueStateGuard: { statuses: ["todo", "in_progress", "blocked", "in_review"], assigneeAgentId: workerAgent.id },
      });
      if (!run) {
        await releaseClaim(claim.id, "wake_rejected");
        await recordActivity(actor, {
          companyId: issue.companyId,
          action: "route_attempt.wake_rejected",
          entityType: "route_decision",
          entityId: decision.id,
          issueId: issue.id,
          details: { role, profileId: decision.worker.profileId, agentId: workerAgent.id },
        });
        return { dispatched: false, decision, reason: "wake_rejected" };
      }
      await db.update(routePoolClaims).set({ runId: run.id }).where(eq(routePoolClaims.id, claim.id));
      await appendRouteRunEvent(run, decision, role);
      await recordActivity(actor, {
        companyId: issue.companyId,
        action: "route_attempt.dispatched",
        entityType: "route_decision",
        entityId: decision.id,
        issueId: issue.id,
        details: { ...decisionAuditDetails(decision), role, claimId: claim.id, runId: run.id },
      });
      return { dispatched: true, decision, claim: { ...claim, runId: run.id }, runId: run.id };
    } catch (error) {
      await releaseClaim(claim.id, "dispatch_failed");
      throw error;
    }
  }

  async function blockForBoard(issue: IssueRow, action: string, actor: RoutingActor): Promise<boolean> {
    if (issue.status === "done" || issue.status === "cancelled") return false;
    if (await liveRunForIssue(issue)) return false;
    await issuesSvc.update(issue.id, {
      status: "blocked",
      unblockDescriptor: { owner: "board", action },
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
      actorAgentId: actor.actorType === "agent" ? actor.agentId : null,
    });
    return true;
  }

  /**
   * Records a typed escalation. The first escalation produces a rescue revision
   * (opposite-family rescuer, recomputed reviewer); a second one requires human
   * attention and parks the issue on a board-owned waiting path.
   */
  async function escalate(issueId: string, reason: RouteEscalationReason, note: string | undefined, actor: RoutingActor): Promise<RouteDecision> {
    const issue = await loadIssue(issueId);
    const history = await listDecisionRows(issue.companyId, issue.id);
    const current = history[0] ? toDecision(history[0]) : null;
    if (!current) throw conflict("Issue has no route decision to escalate", { code: "route_decision_missing" });
    const context = await policyContext(issue);
    const outcome = decideRoute({
      facts: current.facts,
      rules: context.rules,
      profiles: context.profiles,
      activeClaimsByProfile: context.activeClaimsByProfile,
      blockedProfileIds: context.blocked,
      priorWorkerAgentIds: priorWorkerAgentIds(history),
      revisionKind: "rescue",
      escalationReason: reason,
      previous: { revisionKind: current.revisionKind, effectiveTaskClass: current.effectiveTaskClass, facts: current.facts, worker: current.worker, requireCrossFamilyReview: current.requireCrossFamilyReview },
    });
    const revisionKind = outcome.state === "routed" ? "rescue" : "escalation";
    const { decision } = await appendDecision({ issue, outcome, revisionKind, actor, note: note ?? null });
    let blocked = false;
    if (decision.state !== "routed") {
      blocked = await blockForBoard(issue, `Route escalation (${reason}) needs a human decision: rescue is exhausted or no valid rescuer/reviewer exists`, actor);
    }
    await recordActivity(actor, {
      companyId: issue.companyId,
      action: revisionKind === "rescue" ? "route_decision.rescued" : "route_decision.escalated",
      entityType: "route_decision",
      entityId: decision.id,
      issueId: issue.id,
      details: { ...decisionAuditDetails(decision), previousWorkerProviderFamily: current.worker?.providerFamily ?? null, blockedForBoard: blocked },
    });
    return decision;
  }

  /** Board-only, expected-revision fenced, invariant-checked reroute. An invariant-violating override is rejected, never persisted. */
  async function override(issueId: string, input: OverrideRouteInput, actor: RoutingActor): Promise<RouteDecision> {
    const issue = await loadIssue(issueId);
    const history = await listDecisionRows(issue.companyId, issue.id);
    const current = history[0] ? toDecision(history[0]) : null;
    if (!current) throw conflict("Issue has no route decision to override", { code: "route_decision_missing" });
    if (current.revision !== input.expectedRevision) {
      throw conflict("Route decision revision conflict", { code: "route_revision_conflict", currentRevision: current.revision, expectedRevision: input.expectedRevision });
    }
    const overrideRequest: RouteOverrideRequest = {
      workerProfileId: input.workerProfileId,
      reviewerProfileId: input.reviewerProfileId,
      advisorProfileId: input.advisorProfileId,
      requireCrossFamilyReview: input.requireCrossFamilyReview,
    };
    const context = await policyContext(issue);
    const outcome = decideRoute({
      facts: current.facts,
      rules: context.rules,
      profiles: context.profiles,
      activeClaimsByProfile: context.activeClaimsByProfile,
      blockedProfileIds: context.blocked,
      priorWorkerAgentIds: priorWorkerAgentIds(history).filter((agentId) => agentId !== (input.workerProfileId ? undefined : current.worker?.agentId)),
      revisionKind: "override",
      previous: { revisionKind: current.revisionKind, effectiveTaskClass: current.effectiveTaskClass, facts: current.facts, worker: current.worker, requireCrossFamilyReview: current.requireCrossFamilyReview },
      override: overrideRequest,
    });
    if (outcome.state !== "routed") {
      throw unprocessable(`Override violates routing invariants: ${outcome.state}`, { code: outcome.state, reasonCodes: outcome.reasonCodes });
    }
    if (outcome.worker && priorWorkerAgentIds(history).includes(outcome.worker.agentId) && outcome.worker.agentId !== current.worker?.agentId) {
      throw unprocessable("Override cannot hand work to an agent that already authored a rejected attempt", { code: "override-prior-author" });
    }
    const { decision } = await appendDecision({ issue, outcome, revisionKind: "override", actor, note: input.note, expectedRevision: input.expectedRevision });
    await recordActivity(actor, {
      companyId: issue.companyId,
      action: "route_decision.overridden",
      entityType: "route_decision",
      entityId: decision.id,
      issueId: issue.id,
      details: { ...decisionAuditDetails(decision), expectedRevision: input.expectedRevision, note: redactSensitiveText(input.note) },
    });
    return decision;
  }

  async function reviewerAvailable(companyId: string, candidate: RouteDecisionParticipant, issue: IssueRow): Promise<boolean> {
    const profile = await db
      .select()
      .from(executionProfiles)
      .where(and(eq(executionProfiles.id, candidate.profileId), eq(executionProfiles.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!profile || !profile.enabled || !profile.roleCapabilities.includes("reviewer")) return false;
    const agent = await db.select().from(agents).where(eq(agents.id, candidate.agentId)).then((rows) => rows[0] ?? null);
    if (!(await evaluateAgentInvokabilityFromDb(db, agent)).invokable) return false;
    if (await budgets.getInvocationBlock(companyId, candidate.agentId, { issueId: issue.id, projectId: issue.projectId })) return false;
    return true;
  }

  /**
   * Creates (or returns) the independent review child for the current decision
   * and wakes the reviewer. The reviewer works on its own issue and marks it
   * done; the parent is blocked by it. When no valid opposite-family reviewer is
   * available, high-risk work is parked on a board-owned waiting path — never
   * self-reviewed and never silently waived.
   */
  async function requestReview(issueId: string, actor: RoutingActor): Promise<ReviewRequestResult> {
    const issue = await loadIssue(issueId);
    const history = await listDecisionRows(issue.companyId, issue.id);
    const decision = history[0] ? toDecision(history[0]) : null;
    if (!decision) throw conflict("Issue has no route decision", { code: "route_decision_missing" });
    if (!decision.requireCrossFamilyReview) return { state: "not-required", decision };
    if (decision.state !== "routed" || !decision.worker) {
      throw conflict(`Route decision is ${decision.state}; review cannot be requested`, { code: decision.state });
    }
    const existing = await findActiveReviewIssue(issue.companyId, decision.id);
    if (existing && decision.reviewer && existing.assigneeAgentId === decision.reviewer.agentId) {
      return { state: "requested", reviewIssueId: existing.id, reviewer: decision.reviewer, created: false };
    }
    const authors = priorWorkerAgentIds(history);
    let reviewer: RouteDecisionParticipant | null = null;
    for (const candidate of [decision.reviewer, decision.reviewerFallback]) {
      if (!candidate) continue;
      if (authors.includes(candidate.agentId) || candidate.agentId === decision.worker.agentId) continue;
      if (!reviewerFamilyAllowed(decision.worker.providerFamily, candidate.providerFamily)) continue;
      if (await reviewerAvailable(issue.companyId, candidate, issue)) {
        reviewer = candidate;
        break;
      }
    }
    if (!reviewer) {
      const blocked = await blockForBoard(issue, "Required cross-family review cannot start: no opposite-family reviewer is available. Enable or configure a reviewer profile, then request review again.", actor);
      await recordActivity(actor, {
        companyId: issue.companyId,
        action: "route_review.unavailable",
        entityType: "route_decision",
        entityId: decision.id,
        issueId: issue.id,
        details: { ...decisionAuditDetails(decision), state: "reviewer-unavailable", blockedForBoard: blocked },
      });
      return { state: "reviewer-unavailable", decision, blocked };
    }
    const enqueueWakeup = deps.enqueueWakeup;
    const created = await issuesSvc.createChild(issue.id, {
      title: `Review: ${issue.title}`.slice(0, 240),
      description: [
        `Independent ${reviewer.providerFamily} review of ${issue.identifier ?? issue.id} (${issue.id}).`,
        "",
        `Route decision: ${decision.id} (revision ${decision.revision}, ${decision.effectiveTaskClass}).`,
        `Worker family: ${decision.worker.providerFamily}. Reviewer family: ${reviewer.providerFamily}.`,
        "",
        "Review the implementation attempt read-only. Post your findings and verdict as comments on THIS review task and mark it done.",
        "Do not comment on, edit, or change the status of the parent task. Adverse findings are routed to the parent owner as correction work when this review completes.",
        "Your verdict is evidence for the parent owner and the delivery gates; it does not approve delivery by itself.",
      ].join("\n"),
      status: "todo",
      priority: issue.priority,
      projectId: issue.projectId,
      assigneeAgentId: reviewer.agentId,
      assigneeUserId: null,
      reviewPolicy: "not_creator",
      originKind: ROUTE_REVIEW_ORIGIN_KIND,
      originId: decision.id,
      originFingerprint: `review:${decision.id}`,
      idempotencyKey: `route-review:${decision.id}`,
      blockParentUntilDone: true,
      executionWorkspaceInheritanceMode: "strategy_only",
      actorAgentId: actor.actorType === "agent" ? actor.agentId : null,
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    const reviewIssue = created.issue;
    let claim: RoutePoolClaim | null = null;
    try {
      claim = await claimSlot({ companyId: issue.companyId, profileId: reviewer.profileId, decisionId: decision.id, issueId: issue.id, role: "reviewer" });
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 409)) throw error;
    }
    if (enqueueWakeup) {
      const run = await enqueueWakeup(reviewer.agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "route_review_requested",
        payload: { issueId: reviewIssue.id, routeDecisionId: decision.id, routeRole: "reviewer", reviewedIssueId: issue.id },
        contextSnapshot: {
          issueId: reviewIssue.id,
          taskId: reviewIssue.id,
          source: "routing.review",
          routeDecisionId: decision.id,
          routeRevision: decision.revision,
          routePolicyVersion: decision.policyVersion,
          executionProfileId: reviewer.profileId,
          routeRole: "reviewer",
          reviewedIssueId: issue.id,
        },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        idempotencyKey: `route-review:${decision.id}:${reviewIssue.id}`,
        issueStateGuard: { statuses: ["todo", "in_progress"], assigneeAgentId: reviewer.agentId },
      });
      if (run && claim) {
        await db.update(routePoolClaims).set({ runId: run.id }).where(eq(routePoolClaims.id, claim.id));
        await appendRouteRunEvent(run, decision, "reviewer");
      }
    }
    await recordActivity(actor, {
      companyId: issue.companyId,
      action: "route_review.requested",
      entityType: "route_decision",
      entityId: decision.id,
      issueId: issue.id,
      details: { ...decisionAuditDetails(decision), reviewIssueId: reviewIssue.id, reviewerProfileId: reviewer.profileId, reviewerProviderFamily: reviewer.providerFamily, usedFallback: reviewer.profileId !== decision.reviewer?.profileId },
    });
    return { state: "requested", reviewIssueId: reviewIssue.id, reviewer, created: true };
  }

  return {
    listProfiles,
    getProfile,
    createProfile,
    updateProfile,
    listRules,
    upsertRule,
    applyDefaultRules,
    getIssueRouting,
    getCurrentDecision,
    routeIssue,
    dispatch,
    escalate,
    override,
    requestReview,
    claimSlot,
    releaseIssueClaim,
    reconcileClaims,
    TASK_CLASSES,
  };
}

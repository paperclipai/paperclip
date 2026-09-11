import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * Operator-configured, model-bound executor identities. An execution profile
 * names an existing agent (the credential/model owner) and declares the typed
 * provider family, requested model/effort, and the attempt roles it may fill.
 * Capacity is per profile, never per project.
 */
export const executionProfiles = pgTable(
  "execution_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    providerFamily: text("provider_family").notNull(),
    agentId: uuid("agent_id").notNull(),
    model: text("model").notNull(),
    effort: text("effort").notNull(),
    roleCapabilities: text("role_capabilities").array().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    maxConcurrentAttempts: integer("max_concurrent_attempts").notNull().default(1),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdUq: unique("execution_profiles_company_id_uq").on(table.companyId, table.id),
    companyNameUq: uniqueIndex("execution_profiles_company_name_uq").on(table.companyId, table.name),
    companyAgentUq: uniqueIndex("execution_profiles_company_agent_uq").on(table.companyId, table.agentId),
    agentCompanyFk: foreignKey({
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
      name: "execution_profiles_agent_company_fk",
    }),
    providerFamilyCheck: check(
      "execution_profiles_provider_family_check",
      sql`${table.providerFamily} in ('anthropic', 'openai', 'meta', 'deepseek')`,
    ),
    roleCapabilitiesCheck: check(
      "execution_profiles_role_capabilities_check",
      sql`cardinality(${table.roleCapabilities}) between 1 and 4
        and ${table.roleCapabilities} <@ array['worker', 'advisor', 'reviewer', 'rescuer']::text[]`,
    ),
    boundsCheck: check(
      "execution_profiles_bounds_check",
      sql`${table.maxConcurrentAttempts} > 0 and ${table.version} > 0
        and btrim(${table.name}) <> '' and btrim(${table.model}) <> '' and btrim(${table.effort}) <> ''`,
    ),
  }),
);

/**
 * Per-company, per-task-class routing configuration. Cross-family reviewer
 * validity is enforced by the routing service because a CHECK cannot inspect the
 * referenced profile rows.
 */
export const routeRules = pgTable(
  "route_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    taskClass: text("task_class").notNull(),
    workerProfileId: uuid("worker_profile_id"),
    advisorProfileId: uuid("advisor_profile_id"),
    advisorMode: text("advisor_mode").notNull().default("none"),
    reviewerProfileId: uuid("reviewer_profile_id"),
    reviewerFallbackProfileId: uuid("reviewer_fallback_profile_id"),
    reviewRequirement: text("review_requirement").notNull().default("always"),
    reviewerFallbackPolicy: text("reviewer_fallback_policy").notNull().default("fail_closed"),
    rescueProfileId: uuid("rescue_profile_id"),
    maxAttempts: integer("max_attempts").notNull().default(2),
    maxWallClockMinutes: integer("max_wall_clock_minutes").notNull().default(180),
    maxCostCents: integer("max_cost_cents"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdUq: unique("route_rules_company_id_uq").on(table.companyId, table.id),
    companyTaskClassUq: uniqueIndex("route_rules_company_task_class_uq").on(table.companyId, table.taskClass),
    workerProfileFk: foreignKey({
      columns: [table.companyId, table.workerProfileId],
      foreignColumns: [executionProfiles.companyId, executionProfiles.id],
      name: "route_rules_worker_profile_fk",
    }),
    advisorProfileFk: foreignKey({
      columns: [table.companyId, table.advisorProfileId],
      foreignColumns: [executionProfiles.companyId, executionProfiles.id],
      name: "route_rules_advisor_profile_fk",
    }),
    reviewerProfileFk: foreignKey({
      columns: [table.companyId, table.reviewerProfileId],
      foreignColumns: [executionProfiles.companyId, executionProfiles.id],
      name: "route_rules_reviewer_profile_fk",
    }),
    reviewerFallbackProfileFk: foreignKey({
      columns: [table.companyId, table.reviewerFallbackProfileId],
      foreignColumns: [executionProfiles.companyId, executionProfiles.id],
      name: "route_rules_reviewer_fallback_profile_fk",
    }),
    rescueProfileFk: foreignKey({
      columns: [table.companyId, table.rescueProfileId],
      foreignColumns: [executionProfiles.companyId, executionProfiles.id],
      name: "route_rules_rescue_profile_fk",
    }),
    taskClassCheck: check(
      "route_rules_task_class_check",
      sql`${table.taskClass} in ('feature_standard', 'feature_critical', 'migration', 'bug_fast', 'bug_invariant', 'security_recovery', 'mechanical')`,
    ),
    enumsCheck: check(
      "route_rules_enums_check",
      sql`${table.advisorMode} in ('none', 'optional', 'required')
        and ${table.reviewRequirement} in ('always', 'consequential', 'none')
        and ${table.reviewerFallbackPolicy} in ('fallback', 'fail_closed')`,
    ),
    boundsCheck: check(
      "route_rules_bounds_check",
      sql`${table.maxAttempts} > 0 and ${table.maxWallClockMinutes} > 0
        and (${table.maxCostCents} is null or ${table.maxCostCents} >= 0) and ${table.version} > 0`,
    ),
    coherenceCheck: check(
      "route_rules_coherence_check",
      sql`(${table.advisorMode} <> 'none' or ${table.advisorProfileId} is null)
        and (${table.reviewRequirement} <> 'none' or (${table.reviewerProfileId} is null and ${table.reviewerFallbackProfileId} is null))
        and (${table.reviewerProfileId} is null or ${table.reviewerProfileId} <> ${table.workerProfileId})
        and (${table.reviewerFallbackProfileId} is null or ${table.reviewerFallbackProfileId} <> ${table.workerProfileId})
        and (${table.reviewerProfileId} is null or ${table.reviewerFallbackProfileId} is null or ${table.reviewerProfileId} <> ${table.reviewerFallbackProfileId})`,
    ),
  }),
);

const participantColumns = (prefix: string) => ({
  profileId: uuid(`${prefix}_profile_id`),
  agentId: uuid(`${prefix}_agent_id`),
  providerFamily: text(`${prefix}_provider_family`),
  model: text(`${prefix}_model`),
  effort: text(`${prefix}_effort`),
});

const worker = participantColumns("worker");
const advisor = participantColumns("advisor");
const reviewer = participantColumns("reviewer");
const reviewerFallback = participantColumns("reviewer_fallback");
const rescue = participantColumns("rescue");

/**
 * Immutable, append-only route decisions. Revision 1 is the initial decision;
 * every later revision names the decision it supersedes. Rows are never updated.
 * The selected participants are snapshotted (requested model/effort) so later
 * profile edits cannot rewrite history; the effective model belongs to the run.
 */
export const routeDecisions = pgTable(
  "route_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull(),
    revision: integer("revision").notNull(),
    supersedesDecisionId: uuid("supersedes_decision_id"),
    revisionKind: text("revision_kind").notNull(),
    policyVersion: text("policy_version").notNull(),
    taskClass: text("task_class").notNull(),
    effectiveTaskClass: text("effective_task_class").notNull(),
    facts: jsonb("facts").$type<Record<string, unknown>>(),
    state: text("state").notNull(),
    workerProfileId: worker.profileId,
    workerAgentId: worker.agentId,
    workerProviderFamily: worker.providerFamily,
    workerModel: worker.model,
    workerEffort: worker.effort,
    advisorProfileId: advisor.profileId,
    advisorAgentId: advisor.agentId,
    advisorProviderFamily: advisor.providerFamily,
    advisorModel: advisor.model,
    advisorEffort: advisor.effort,
    advisorMode: text("advisor_mode").notNull().default("none"),
    reviewerProfileId: reviewer.profileId,
    reviewerAgentId: reviewer.agentId,
    reviewerProviderFamily: reviewer.providerFamily,
    reviewerModel: reviewer.model,
    reviewerEffort: reviewer.effort,
    reviewerFallbackProfileId: reviewerFallback.profileId,
    reviewerFallbackAgentId: reviewerFallback.agentId,
    reviewerFallbackProviderFamily: reviewerFallback.providerFamily,
    reviewerFallbackModel: reviewerFallback.model,
    reviewerFallbackEffort: reviewerFallback.effort,
    rescueProfileId: rescue.profileId,
    rescueAgentId: rescue.agentId,
    rescueProviderFamily: rescue.providerFamily,
    rescueModel: rescue.model,
    rescueEffort: rescue.effort,
    requireCrossFamilyReview: boolean("require_cross_family_review").notNull().default(true),
    maxAttempts: integer("max_attempts").notNull(),
    maxWallClockMinutes: integer("max_wall_clock_minutes").notNull(),
    maxCostCents: integer("max_cost_cents"),
    reasonCodes: text("reason_codes").array().notNull().default([]),
    escalationReason: text("escalation_reason"),
    note: text("note"),
    createdByType: text("created_by_type").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdUq: unique("route_decisions_company_issue_id_uq").on(table.companyId, table.issueId, table.id),
    companyIssueRevisionUq: uniqueIndex("route_decisions_company_issue_revision_uq").on(
      table.companyId,
      table.issueId,
      table.revision,
    ),
    issueCompanyFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "route_decisions_issue_company_fk",
    }).onDelete("cascade"),
    supersedesOwnerFk: foreignKey({
      columns: [table.companyId, table.issueId, table.supersedesDecisionId],
      foreignColumns: [table.companyId, table.issueId, table.id],
      name: "route_decisions_supersedes_owner_fk",
    }),
    workerProfileFk: foreignKey({
      columns: [table.companyId, table.workerProfileId],
      foreignColumns: [executionProfiles.companyId, executionProfiles.id],
      name: "route_decisions_worker_profile_fk",
    }),
    reviewerProfileFk: foreignKey({
      columns: [table.companyId, table.reviewerProfileId],
      foreignColumns: [executionProfiles.companyId, executionProfiles.id],
      name: "route_decisions_reviewer_profile_fk",
    }),
    revisionCheck: check(
      "route_decisions_revision_check",
      sql`${table.revision} > 0
        and ((${table.revision} = 1 and ${table.supersedesDecisionId} is null)
          or (${table.revision} > 1 and ${table.supersedesDecisionId} is not null))`,
    ),
    enumsCheck: check(
      "route_decisions_enums_check",
      sql`${table.revisionKind} in ('initial', 'escalation', 'fallback', 'override', 'rescue')
        and ${table.state} in ('routed', 'classification-required', 'no-capable-worker', 'reviewer-family-conflict', 'reviewer-unavailable', 'budget-limited', 'escalation-required')
        and ${table.advisorMode} in ('none', 'optional', 'required')
        and ${table.createdByType} in ('user', 'agent', 'system')
        and ${table.reasonCodes} <@ array['cross-layer', 'persistent-schema', 'security-sensitive', 'recovery-invariant', 'concurrency-invariant', 'known-reproduction', 'mechanical-cutover', 'review-rejected', 'repeated-failure', 'provider-unavailable', 'budget-limited']::text[]`,
    ),
    boundsCheck: check(
      "route_decisions_bounds_check",
      sql`${table.maxAttempts} > 0 and ${table.maxWallClockMinutes} > 0
        and (${table.maxCostCents} is null or ${table.maxCostCents} >= 0)`,
    ),
    workerStateCheck: check(
      "route_decisions_worker_state_check",
      sql`(${table.state} <> 'routed' or ${table.workerProfileId} is not null)
        and (${table.workerProfileId} is null) = (${table.workerAgentId} is null)
        and (${table.reviewerProfileId} is null) = (${table.reviewerAgentId} is null)
        and (${table.reviewerProviderFamily} is null or ${table.reviewerProviderFamily} <> ${table.workerProviderFamily})
        and (${table.reviewerAgentId} is null or ${table.reviewerAgentId} <> ${table.workerAgentId})`,
    ),
    actorCheck: check(
      "route_decisions_actor_check",
      sql`(${table.createdByType} = 'user' and ${table.createdByUserId} is not null and ${table.createdByAgentId} is null)
        or (${table.createdByType} = 'agent' and ${table.createdByAgentId} is not null and ${table.createdByUserId} is null)
        or (${table.createdByType} = 'system' and ${table.createdByUserId} is null and ${table.createdByAgentId} is null)`,
    ),
  }),
);

/**
 * Shared-pool capacity claims. One writable claim (worker or rescuer) per issue
 * at a time; capacity is counted under a profile row lock so concurrent claims
 * cannot double-dispatch one slot. Claims are released by run finalization
 * reconciliation or an explicit release, never by elapsed time.
 */
export const routePoolClaims = pgTable(
  "route_pool_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").notNull(),
    decisionId: uuid("decision_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    role: text("role").notNull(),
    runId: uuid("run_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
  },
  (table) => ({
    profileFk: foreignKey({
      columns: [table.companyId, table.profileId],
      foreignColumns: [executionProfiles.companyId, executionProfiles.id],
      name: "route_pool_claims_profile_fk",
    }),
    issueFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "route_pool_claims_issue_fk",
    }).onDelete("cascade"),
    decisionFk: foreignKey({
      columns: [table.companyId, table.issueId, table.decisionId],
      foreignColumns: [routeDecisions.companyId, routeDecisions.issueId, routeDecisions.id],
      name: "route_pool_claims_decision_fk",
    }).onDelete("cascade"),
    runFk: foreignKey({
      columns: [table.companyId, table.runId],
      foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id],
      name: "route_pool_claims_run_fk",
    }),
    activeIssueRoleUq: uniqueIndex("route_pool_claims_active_issue_role_uq")
      .on(table.companyId, table.issueId, table.role)
      .where(sql`${table.releasedAt} is null`),
    activeWritableIssueUq: uniqueIndex("route_pool_claims_active_writable_issue_uq")
      .on(table.companyId, table.issueId)
      .where(sql`${table.releasedAt} is null and ${table.role} in ('worker', 'rescuer')`),
    activeProfileIdx: index("route_pool_claims_active_profile_idx")
      .on(table.companyId, table.profileId)
      .where(sql`${table.releasedAt} is null`),
    roleCheck: check(
      "route_pool_claims_role_check",
      sql`${table.role} in ('worker', 'advisor', 'reviewer', 'rescuer')`,
    ),
    releaseCheck: check(
      "route_pool_claims_release_check",
      sql`(${table.releasedAt} is null) = (${table.releaseReason} is null)
        and (${table.releasedAt} is null or ${table.releasedAt} >= ${table.claimedAt})`,
    ),
  }),
);

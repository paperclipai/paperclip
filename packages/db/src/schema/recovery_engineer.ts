import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  RecoveryEngineerClassification,
  RecoveryEngineerIncidentOutcome,
  RecoveryEngineerProcedureApplicability,
  RecoveryEngineerProcedureReuseStatus,
  RecoveryEngineerRepairProjectIds,
  RecoveryEngineerSourceCloseReason,
} from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

export const recoveryEngineerConfigs = pgTable(
  "recovery_engineer_configs",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    repairAgentId: uuid("repair_agent_id").notNull().references(() => agents.id),
    reviewerAgentId: uuid("reviewer_agent_id").notNull().references(() => agents.id),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    repairProjectIds: jsonb("repair_project_ids").$type<RecoveryEngineerRepairProjectIds>(),
    maxAttempts: integer("max_attempts").notNull().default(1),
    sweepIntervalSec: integer("sweep_interval_sec").notNull().default(300),
    lastSweepAt: timestamp("last_sweep_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    attemptsCheck: check("recovery_engineer_configs_attempts_check", sql`${table.maxAttempts} = 1`),
    intervalCheck: check("recovery_engineer_configs_interval_check", sql`${table.sweepIntervalSec} = 300`),
    distinctAgentsCheck: check(
      "recovery_engineer_configs_distinct_agents_check",
      sql`${table.agentId} <> ${table.repairAgentId}
        and ${table.agentId} <> ${table.reviewerAgentId}
        and ${table.repairAgentId} <> ${table.reviewerAgentId}`,
    ),
  }),
);

export const recoveryEngineerIncidents = pgTable(
  "recovery_engineer_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    failureFingerprint: text("failure_fingerprint").notNull(),
    status: text("status").notNull().default("suspected"),
    // Repair outcome, separate from the lifecycle stage in `status`:
    // `pending` = at least one source generation is still open, `recovered` =
    // every source generation closed with evidence, `unresolved` = the
    // incident can no longer claim recovery (superseded, cancelled, stale or
    // exhausted generations).
    outcome: text("outcome").$type<RecoveryEngineerIncidentOutcome>().notNull().default("pending"),
    outcomeUpdatedAt: timestamp("outcome_updated_at", { withTimezone: true }),
    classification: text("classification").$type<RecoveryEngineerClassification>(),
    hypothesis: text("hypothesis"),
    rootCause: text("root_cause"),
    evidence: jsonb("evidence").$type<string[]>().notNull().default([]),
    maintenanceIssueId: uuid("maintenance_issue_id").references(() => issues.id, { onDelete: "set null" }),
    diagnosisAttemptCount: integer("diagnosis_attempt_count").notNull().default(0),
    diagnosisRunId: uuid("diagnosis_run_id"),
    diagnosisRequestedAt: timestamp("diagnosis_requested_at", { withTimezone: true }),
    boardEscalatedAt: timestamp("board_escalated_at", { withTimezone: true }),
    boardEscalationReason: text("board_escalation_reason"),
    repairTarget: text("repair_target").$type<"framework" | "native">(),
    repairProjectId: uuid("repair_project_id").references(() => projects.id),
    repairIssueId: uuid("repair_issue_id").references(() => issues.id, { onDelete: "set null" }),
    repairRunId: uuid("repair_run_id"),
    repairCommit: text("repair_commit"),
    verifiedVerificationId: uuid("verified_verification_id"),
    verifiedReviewRunId: uuid("verified_review_run_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    activatedRepairCommit: text("activated_repair_commit"),
    activationEvidence: text("activation_evidence"),
    activatedByUserId: text("activated_by_user_id"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    resumedSourceIssueId: uuid("resumed_source_issue_id").references(() => issues.id, { onDelete: "set null" }),
    resumedRunId: uuid("resumed_run_id"),
    resumedAt: timestamp("resumed_at", { withTimezone: true }),
    suspectedAt: timestamp("suspected_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyFingerprintUq: uniqueIndex("recovery_engineer_incidents_company_fingerprint_uq").on(
      table.companyId,
      table.failureFingerprint,
    ),
    companyStatusIdx: index("recovery_engineer_incidents_company_status_idx").on(
      table.companyId,
      table.status,
      table.updatedAt,
    ),
    companyOutcomeIdx: index("recovery_engineer_incidents_company_outcome_idx").on(
      table.companyId,
      table.outcome,
      table.updatedAt,
    ),
    maintenanceIssueIdx: index("recovery_engineer_incidents_maintenance_issue_idx").on(
      table.companyId,
      table.maintenanceIssueId,
    ),
    repairIssueIdx: index("recovery_engineer_incidents_repair_issue_idx").on(
      table.companyId,
      table.repairIssueId,
    ),
    diagnosisAttemptsCheck: check(
      "recovery_engineer_incidents_diagnosis_attempts_check",
      sql`${table.diagnosisAttemptCount} between 0 and 1`,
    ),
  }),
);

export const recoveryEngineerIncidentSources = pgTable(
  "recovery_engineer_incident_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => recoveryEngineerIncidents.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    sourceRunId: uuid("source_run_id"),
    generationKey: text("generation_key").notNull(),
    originalOwnerAgentId: uuid("original_owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    originalOwnerUserId: text("original_owner_user_id"),
    sourceStatus: text("source_status").notNull(),
    sourceStatusVersion: bigint("source_status_version", { mode: "number" }).notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
    checkoutRunId: uuid("checkout_run_id"),
    executionRunId: uuid("execution_run_id"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    // A generation is closed either with recovery evidence (original-path or
    // native closure) or as superseded. `recoveredAt` alone never means "a
    // continuation was queued": the resume claim/dispatch columns below record
    // that separately, and recovery evidence names the run that proved the
    // source path overcame this failure.
    recoveredAt: timestamp("recovered_at", { withTimezone: true }),
    recoveredRunId: uuid("recovered_run_id"),
    recoveredEvidence: jsonb("recovered_evidence").$type<Record<string, unknown>>(),
    resumeClaimedAt: timestamp("resume_claimed_at", { withTimezone: true }),
    // Persisted dispatch intent: the same key is replayed after a crash, so a
    // restart cannot lose the wake nor mint a duplicate one.
    resumeIdempotencyKey: text("resume_idempotency_key"),
    resumeAttemptCount: integer("resume_attempt_count").notNull().default(0),
    resumeLastAttemptAt: timestamp("resume_last_attempt_at", { withTimezone: true }),
    resumeDispatchedAt: timestamp("resume_dispatched_at", { withTimezone: true }),
    resumeFailureReason: text("resume_failure_reason"),
    resumedAt: timestamp("resumed_at", { withTimezone: true }),
    resumedRunId: uuid("resumed_run_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededReason: text("superseded_reason").$type<RecoveryEngineerSourceCloseReason>(),
    supersededBySourceId: uuid("superseded_by_source_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    incidentSourceGenerationUq: uniqueIndex(
      "recovery_engineer_incident_sources_incident_source_generation_uq",
    ).on(table.incidentId, table.sourceIssueId, table.generationKey),
    companySourceIdx: index("recovery_engineer_incident_sources_company_source_idx").on(
      table.companyId,
      table.sourceIssueId,
      table.observedAt,
    ),
    incidentObservedIdx: index("recovery_engineer_incident_sources_incident_observed_idx").on(
      table.incidentId,
      table.observedAt,
      table.id,
    ),
    companyOpenSourceIdx: index("recovery_engineer_incident_sources_company_open_idx").on(
      table.companyId,
      table.supersededAt,
      table.recoveredAt,
      table.resumeClaimedAt,
    ),
    closeExclusivityCheck: check(
      "recovery_engineer_incident_sources_close_exclusivity_check",
      sql`not (${table.recoveredAt} is not null and ${table.supersededAt} is not null)`,
    ),
  }),
);

export const recoveryEngineerProcedures = pgTable(
  "recovery_engineer_procedures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => recoveryEngineerIncidents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("proposed"),
    title: text("title").notNull(),
    preconditions: jsonb("preconditions").$type<string[]>().notNull(),
    steps: jsonb("steps").$type<string[]>().notNull(),
    successCheck: text("success_check").notNull(),
    stopConditions: jsonb("stop_conditions").$type<string[]>().notNull(),
    rollback: text("rollback").notNull(),
    evidenceRunId: uuid("evidence_run_id").notNull(),
    repairCommit: text("repair_commit").notNull(),
    failureFingerprint: text("failure_fingerprint").notNull(),
    classification: text("classification").$type<RecoveryEngineerClassification>(),
    // Context snapshot captured from the evidence run at proposal time. Reuse
    // re-matches it, so a review of one context never authorizes another.
    applicability: jsonb("applicability").$type<RecoveryEngineerProcedureApplicability>(),
    failedReuseCount: integer("failed_reuse_count").notNull().default(0),
    lastReuseOutcome: text("last_reuse_outcome").$type<RecoveryEngineerProcedureReuseStatus>(),
    lastReusedAt: timestamp("last_reused_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidatedReason: text("invalidated_reason"),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    proposedByRunId: uuid("proposed_by_run_id"),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("recovery_engineer_procedures_company_status_idx").on(
      table.companyId,
      table.status,
      table.updatedAt,
    ),
    incidentIdx: index("recovery_engineer_procedures_incident_idx").on(
      table.incidentId,
      table.createdAt,
    ),
    statusCheck: check(
      "recovery_engineer_procedures_status_check",
      sql`${table.status} in ('proposed', 'reviewed', 'retired')`,
    ),
  }),
);

export const recoveryEngineerVerifications = pgTable(
  "recovery_engineer_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => recoveryEngineerIncidents.id, { onDelete: "cascade" }),
    repairIssueId: uuid("repair_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    reviewRunId: uuid("review_run_id").notNull(),
    status: text("status").notNull().default("pending"),
    repairCommit: text("repair_commit").notNull(),
    reproductionCommand: text("reproduction_command").notNull(),
    reproductionResult: text("reproduction_result").notNull(),
    failureReason: text("failure_reason"),
    // Set when a later independent review confirms the already-verified repair
    // commit: the verification is accepted idempotently and attributed to the
    // fence that already verified the incident, which is never re-attributed.
    duplicateOfVerificationId: uuid("duplicate_of_verification_id"),
    submittedByAgentId: uuid("submitted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    submittedByUserId: text("submitted_by_user_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyReviewRunUq: uniqueIndex("recovery_engineer_verifications_company_review_run_uq").on(
      table.companyId,
      table.reviewRunId,
    ),
    incidentStatusIdx: index("recovery_engineer_verifications_incident_status_idx").on(
      table.incidentId,
      table.status,
      table.updatedAt,
    ),
    statusCheck: check(
      "recovery_engineer_verifications_status_check",
      sql`${table.status} in ('pending', 'verified', 'failed')`,
    ),
  }),
);

/**
 * Durable reuse ledger for reviewed procedures. A procedure is diagnostic data
 * bound to the context it was reviewed in, never an executable grant: every
 * application is recorded with the evidence key it was applied against, and a
 * failed application increments the procedure's failure count so a repeated
 * failure demands new evidence or a new review instead of a blind retry.
 */
export const recoveryEngineerProcedureReuses = pgTable(
  "recovery_engineer_procedure_reuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => recoveryEngineerIncidents.id, { onDelete: "cascade" }),
    procedureId: uuid("procedure_id")
      .notNull()
      .references(() => recoveryEngineerProcedures.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    sourceGenerationKey: text("source_generation_key").notNull(),
    failureFingerprint: text("failure_fingerprint").notNull(),
    evidenceKey: text("evidence_key").notNull(),
    status: text("status").$type<RecoveryEngineerProcedureReuseStatus>().notNull().default("applied"),
    refusalReason: text("refusal_reason"),
    applicability: jsonb("applicability").$type<Record<string, unknown>>().notNull().default({}),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    appliedByAgentId: uuid("applied_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    appliedByRunId: uuid("applied_by_run_id"),
    appliedByUserId: text("applied_by_user_id"),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    outcomeAt: timestamp("outcome_at", { withTimezone: true }),
    outcomeRunId: uuid("outcome_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    reuseKeyUq: uniqueIndex("recovery_engineer_procedure_reuses_key_uq").on(
      table.companyId,
      table.procedureId,
      table.incidentId,
      table.sourceIssueId,
      table.sourceGenerationKey,
      table.evidenceKey,
    ),
    companyStatusIdx: index("recovery_engineer_procedure_reuses_company_status_idx").on(
      table.companyId,
      table.status,
      table.updatedAt,
    ),
    procedureAppliedIdx: index("recovery_engineer_procedure_reuses_procedure_applied_idx").on(
      table.procedureId,
      table.appliedAt,
    ),
    statusCheck: check(
      "recovery_engineer_procedure_reuses_status_check",
      sql`${table.status} in ('applied', 'succeeded', 'failed', 'refused')`,
    ),
  }),
);

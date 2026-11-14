import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { projects } from "./projects.js";

/**
 * Project task-execution policy, kept apart from `projects` so unenforced caps
 * never reach project readers. No row: never configured. Null maximum: explicit
 * unlimited. Owned by the execution-admission module.
 */
export const projectTaskExecutionPolicies = pgTable("project_task_execution_policies", {
  projectId: uuid("project_id").primaryKey(),
  companyId: uuid("company_id").notNull(),
  maxConcurrentTasks: integer("max_concurrent_tasks"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  project: foreignKey({ columns: [t.companyId, t.projectId], foreignColumns: [projects.companyId, projects.id],
    name: "project_task_execution_policies_company_project_fk" }).onDelete("cascade"),
  maximum: check("project_task_execution_policies_maximum_check", sql`${t.maxConcurrentTasks} is null or ${t.maxConcurrentTasks} > 0`),
}));

/**
 * One admission attempt of a run. A run can be admitted again after a settled
 * attempt, so the run ID is not the admission identity. Primary project is
 * provenance only. `admittedProjectIds` is the complete admitted set, sorted and
 * immutable (trigger), kept after settlement without project foreign keys. Null
 * means unknown: settled before the set was recorded. Charges below are the
 * active capacity only.
 */
export const executionAdmissions = pgTable("execution_admissions", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
  attempt: integer("attempt").notNull(),
  primaryProjectId: uuid("primary_project_id"),
  contextRevision: text("context_revision").notNull(),
  admittedProjectIds: uuid("admitted_project_ids").array(),
  settlementId: uuid("settlement_id"),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  companyIdentity: uniqueIndex("execution_admissions_company_id_uq").on(t.companyId, t.id),
  runAttempt: uniqueIndex("execution_admissions_run_attempt_uq").on(t.runId, t.attempt),
  liveRun: uniqueIndex("execution_admissions_live_run_uq").on(t.runId).where(sql`${t.settledAt} is null`),
  attemptCheck: check("execution_admissions_attempt_check", sql`${t.attempt} > 0`),
  settlementCheck: check("execution_admissions_settlement_check", sql`(${t.settlementId} is null) = (${t.settledAt} is null)`),
  projectSetCheck: check("execution_admissions_project_set_check", sql`case when ${t.admittedProjectIds} is null
    then ${t.settledAt} is not null else array_position(${t.admittedProjectIds}, null) is null and cardinality(${t.admittedProjectIds}) <= 100 end`),
}));

/** One active charge per distinct admitted project. Settlement deletes the whole set; a charged project cannot be deleted. */
export const executionAdmissionProjectCharges = pgTable("execution_admission_project_charges", {
  admissionId: uuid("admission_id").notNull(),
  companyId: uuid("company_id").notNull(),
  projectId: uuid("project_id").notNull(),
}, t => ({
  identity: primaryKey({ columns: [t.admissionId, t.projectId] }),
  admission: foreignKey({ columns: [t.companyId, t.admissionId], foreignColumns: [executionAdmissions.companyId, executionAdmissions.id],
    name: "execution_admission_project_charges_company_admission_fk" }).onDelete("cascade"),
  project: foreignKey({ columns: [t.companyId, t.projectId], foreignColumns: [projects.companyId, projects.id],
    name: "execution_admission_project_charges_company_project_fk" }),
  activeProject: index("execution_admission_project_charges_project_idx").on(t.companyId, t.projectId),
}));

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { nativeRunResults } from "./native_run_results.js";
import { statusDecisions } from "./status_decisions.js";
import { workAssessments } from "./work_assessments.js";

export const nativeRunFinalizations = pgTable(
  "native_run_finalizations",
  {
    runId: uuid("run_id").primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull(),
    phase: text("phase").notNull(),
    attempt: integer("attempt").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    controllerBootId: text("controller_boot_id"),
    controllerPid: integer("controller_pid"),
    controllerProcessStartedAt: timestamp("controller_process_started_at", {
      withTimezone: true,
    }),
    controllerGeneration: integer("controller_generation").notNull().default(0),
    recoveryState: text("recovery_state"),
    recoveryRequestId: text("recovery_request_id"),
    recoveryHistory: jsonb("recovery_history")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    resultId: uuid("result_id"),
    assessmentId: uuid("assessment_id"),
    decisionId: uuid("decision_id"),
    failureCode: text("failure_code"),
    failureDetail: jsonb("failure_detail").$type<Record<string, unknown>>(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueCompanyFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "native_run_finalizations_issue_company_fk",
    }),
    runOwnerFk: foreignKey({
      columns: [table.companyId, table.issueId, table.runId],
      foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.nativeIssueId, heartbeatRuns.id],
      name: "native_run_finalizations_run_owner_fk",
    }),
    resultOwnerFk: foreignKey({
      columns: [table.companyId, table.issueId, table.runId, table.resultId],
      foreignColumns: [
        nativeRunResults.companyId,
        nativeRunResults.issueId,
        nativeRunResults.runId,
        nativeRunResults.id,
      ],
      name: "native_run_finalizations_result_owner_fk",
    }),
    assessmentOwnerFk: foreignKey({
      columns: [table.companyId, table.issueId, table.runId, table.assessmentId],
      foreignColumns: [
        workAssessments.companyId,
        workAssessments.issueId,
        workAssessments.runId,
        workAssessments.id,
      ],
      name: "native_run_finalizations_assessment_owner_fk",
    }),
    decisionOwnerFk: foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.runId,
        table.assessmentId,
        table.decisionId,
      ],
      foreignColumns: [
        statusDecisions.companyId,
        statusDecisions.issueId,
        statusDecisions.runId,
        statusDecisions.assessmentId,
        statusDecisions.id,
      ],
      name: "native_run_finalizations_decision_owner_fk",
    }),
    assessmentRequiresResultCheck: check(
      "native_run_finalizations_assessment_requires_result_check",
      sql`${table.assessmentId} is null or ${table.resultId} is not null`,
    ),
    decisionRequiresAssessmentCheck: check(
      "native_run_finalizations_decision_requires_assessment_check",
      sql`${table.decisionId} is null or ${table.assessmentId} is not null`,
    ),
  }),
);

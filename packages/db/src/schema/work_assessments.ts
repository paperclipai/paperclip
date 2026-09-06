import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  jsonb,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { completionContracts } from "./completion_contracts.js";
import { nativeRunResults } from "./native_run_results.js";

export const workAssessments = pgTable(
  "work_assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull(),
    runId: uuid("run_id").notNull(),
    turnId: text("turn_id"),
    contractId: uuid("contract_id").notNull(),
    resultId: uuid("result_id").notNull(),
    triggerKind: text("trigger_kind").notNull(),
    triggerRef: text("trigger_ref"),
    triggerCapability: text("trigger_capability"),
    triggerActorCompanyId: uuid("trigger_actor_company_id").notNull().references(() => companies.id),
    priorIssueStatus: text("prior_issue_status").notNull(),
    priorStatusVersion: bigint("prior_status_version", { mode: "number" }).notNull(),
    priorDecisionId: uuid("prior_decision_id"),
    policyVersion: text("policy_version").notNull(),
    assessmentJson: jsonb("assessment_json").$type<Record<string, unknown>>().notNull(),
    inputDigest: text("input_digest").notNull(),
    supersedesAssessmentId: uuid("supersedes_assessment_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueRunIdUq: unique("work_assessments_company_issue_run_id_uq").on(
      table.companyId,
      table.issueId,
      table.runId,
      table.id,
    ),
    issueCompanyFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "work_assessments_issue_company_fk",
    }),
    runOwnerFk: foreignKey({
      columns: [table.companyId, table.issueId, table.runId],
      foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.nativeIssueId, heartbeatRuns.id],
      name: "work_assessments_run_owner_fk",
    }),
    contractOwnerFk: foreignKey({
      columns: [table.companyId, table.issueId, table.contractId],
      foreignColumns: [
        completionContracts.companyId,
        completionContracts.issueId,
        completionContracts.id,
      ],
      name: "work_assessments_contract_owner_fk",
    }),
    resultOwnerFk: foreignKey({
      columns: [table.companyId, table.issueId, table.runId, table.resultId],
      foreignColumns: [
        nativeRunResults.companyId,
        nativeRunResults.issueId,
        nativeRunResults.runId,
        nativeRunResults.id,
      ],
      name: "work_assessments_result_owner_fk",
    }),
    supersedesOwnerFk: foreignKey({
      columns: [table.companyId, table.issueId, table.runId, table.supersedesAssessmentId],
      foreignColumns: [table.companyId, table.issueId, table.runId, table.id],
      name: "work_assessments_supersedes_owner_fk",
    }),
    triggerActorCompanyCheck: check(
      "work_assessments_trigger_actor_company_check",
      sql`${table.triggerActorCompanyId} = ${table.companyId}`,
    ),
    issueInputUq: uniqueIndex("work_assessments_company_issue_input_uq").on(
      table.companyId,
      table.issueId,
      table.inputDigest,
    ),
  }),
);

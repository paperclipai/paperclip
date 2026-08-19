import { pgTable, uuid, text, timestamp, bigint, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { completionContracts } from "./completion_contracts.js";
import { nativeRunResults } from "./native_run_results.js";

export const workAssessments = pgTable("work_assessments", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
  turnId: text("turn_id"),
  contractId: uuid("contract_id").notNull().references(() => completionContracts.id),
  resultId: uuid("result_id").notNull().references(() => nativeRunResults.id),
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
}, (table) => ({
  issueInputUq: uniqueIndex("work_assessments_company_issue_input_uq")
    .on(table.companyId, table.issueId, table.inputDigest),
}));

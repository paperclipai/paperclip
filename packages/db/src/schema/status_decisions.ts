import { pgTable, uuid, text, timestamp, bigint, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { workAssessments } from "./work_assessments.js";

export const statusDecisions = pgTable("status_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  assessmentId: uuid("assessment_id").notNull().references(() => workAssessments.id),
  decisionVersion: bigint("decision_version", { mode: "number" }).notNull(),
  policyVersion: text("policy_version").notNull(),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  reasonCode: text("reason_code").notNull(),
  decisionJson: jsonb("decision_json").$type<Record<string, unknown>>().notNull(),
  decisionDigest: text("decision_digest").notNull(),
  applicationState: text("application_state").notNull().default("proposed"),
  supersedesDecisionId: uuid("supersedes_decision_id"),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  issueVersionUq: uniqueIndex("status_decisions_company_issue_version_uq")
    .on(table.companyId, table.issueId, table.decisionVersion),
  assessmentUq: uniqueIndex("status_decisions_company_assessment_uq").on(table.companyId, table.assessmentId),
  issueDigestUq: uniqueIndex("status_decisions_company_issue_digest_uq")
    .on(table.companyId, table.issueId, table.decisionDigest),
}));

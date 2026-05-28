import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { documents } from "./documents.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";

export const consultReportArtifacts = pgTable(
  "consult_report_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    accountableIssueId: uuid("accountable_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceCommentId: uuid("source_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    sourceDocumentId: uuid("source_document_id").references(() => documents.id, { onDelete: "set null" }),
    sourceDocumentKey: text("source_document_key"),
    decision: text("decision").notNull(),
    evidence: text("evidence").notNull(),
    risk: text("risk").notNull(),
    nextOwnerText: text("next_owner_text").notNull(),
    nextOwnerAgentId: uuid("next_owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    nextOwnerUserId: text("next_owner_user_id"),
    nextOwnerIssueId: uuid("next_owner_issue_id").references(() => issues.id, { onDelete: "set null" }),
    reportNeeded: boolean("report_needed").notNull().default(false),
    reportReason: text("report_reason"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceIssueCreatedIdx: index("consult_report_artifacts_company_source_issue_created_idx").on(
      table.companyId,
      table.sourceIssueId,
      table.createdAt,
    ),
    companyAccountableIssueCreatedIdx: index("consult_report_artifacts_company_accountable_issue_created_idx").on(
      table.companyId,
      table.accountableIssueId,
      table.createdAt,
    ),
    companyReportNeededCreatedIdx: index("consult_report_artifacts_company_report_needed_created_idx").on(
      table.companyId,
      table.reportNeeded,
      table.createdAt,
    ),
  }),
);

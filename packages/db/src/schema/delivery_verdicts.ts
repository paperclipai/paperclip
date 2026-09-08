import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { deliverySubmissions } from "./delivery_submissions.js";
import { documentRevisions } from "./document_revisions.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import type { DeliveryVerdictFinding } from "@paperclipai/shared";

/**
 * Append-only review verdict on one candidate. There is no update path: a later
 * opinion is a new row, and acceptance only reads the newest verdict for the
 * candidate it is accepting.
 */
export const deliveryVerdicts = pgTable(
  "delivery_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => deliverySubmissions.id, { onDelete: "cascade" }),
    planRevisionId: uuid("plan_revision_id").references(() => documentRevisions.id, { onDelete: "cascade" }),
    candidateHeadSha: text("candidate_head_sha").notNull(),
    verdict: text("verdict").notNull(),
    findings: jsonb("findings").$type<DeliveryVerdictFinding[]>().notNull().default(sql`'[]'::jsonb`),
    reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id, { onDelete: "set null" }),
    reviewerUserId: text("reviewer_user_id"),
    reviewerRunId: uuid("reviewer_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** One verdict per reviewer run per candidate; a retried call is idempotent. */
    reviewerRunUq: uniqueIndex("delivery_verdicts_reviewer_run_uq").on(
      table.companyId,
      table.submissionId,
      table.reviewerAgentId,
      table.reviewerRunId,
    ),
    companyIssueCreatedIdx: index("delivery_verdicts_company_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    submissionIdx: index("delivery_verdicts_submission_idx").on(table.submissionId),
  }),
);

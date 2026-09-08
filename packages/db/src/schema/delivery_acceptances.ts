import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { deliverySubmissions } from "./delivery_submissions.js";
import { deliveryVerdicts } from "./delivery_verdicts.js";
import { documentRevisions } from "./document_revisions.js";
import { issues } from "./issues.js";

/**
 * Acceptance of one candidate by a board/evaluator identity.
 *
 * For an enrolled issue, acceptance is the precondition for reaching `done`.
 * The terminal status write re-checks this row against the candidate — and,
 * for a plan-pinned track, the plan revision — that are current at commit
 * time, so a later plan edit or a newer candidate makes the acceptance stale
 * rather than authoritative.
 */
export const deliveryAcceptances = pgTable(
  "delivery_acceptances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => deliverySubmissions.id, { onDelete: "cascade" }),
    verdictId: uuid("verdict_id").references(() => deliveryVerdicts.id, { onDelete: "set null" }),
    planRevisionId: uuid("plan_revision_id").references(() => documentRevisions.id, { onDelete: "cascade" }),
    candidateHeadSha: text("candidate_head_sha").notNull(),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    acceptedByUserId: text("accepted_by_user_id").notNull(),
    acceptedBySessionId: text("accepted_by_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    candidateUq: uniqueIndex("delivery_acceptances_candidate_uq").on(
      table.companyId,
      table.issueId,
      table.candidateHeadSha,
    ),
    companyIssueCreatedIdx: index("delivery_acceptances_company_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
  }),
);

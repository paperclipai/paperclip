import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { documentRevisions } from "./document_revisions.js";
import { issues } from "./issues.js";

/**
 * Immutable trusted verification evidence.
 *
 * Rows are written only by the board/evaluator ingestion endpoint, so
 * worker-produced JSON never becomes proof. There is no update or delete path,
 * and every row is bound to one company, issue, plan revision, and candidate
 * head, so evidence cannot be replayed onto a different candidate.
 */
export const deliveryVerificationEvidence = pgTable(
  "delivery_verification_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    planRevisionId: uuid("plan_revision_id").references(() => documentRevisions.id, { onDelete: "cascade" }),
    candidateHeadSha: text("candidate_head_sha").notNull(),
    kind: text("kind").notNull(),
    /** sha256 of the raw evidence bytes, computed outside Paperclip. */
    digest: text("digest").notNull(),
    producerLabel: text("producer_label").notNull(),
    producedByUserId: text("produced_by_user_id"),
    producedBySessionId: text("produced_by_session_id"),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    digestUq: uniqueIndex("delivery_verification_evidence_digest_uq").on(
      table.companyId,
      table.issueId,
      table.digest,
    ),
    candidateIdx: index("delivery_verification_evidence_candidate_idx").on(
      table.companyId,
      table.issueId,
      table.candidateHeadSha,
    ),
  }),
);

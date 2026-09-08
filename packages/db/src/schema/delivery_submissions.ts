import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { deliveryTracks } from "./delivery_tracks.js";
import { documentRevisions } from "./document_revisions.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * Candidate delivery recorded against an enrolled issue. A row is a submission,
 * never an acceptance: nothing here can close an issue.
 *
 * Actor pointers are nullable FKs so deleting an agent or a run does not delete
 * the record. Acceptance re-verifies that the pointers still resolve, so a
 * nulled pointer fails closed instead of silently accepting.
 */
export const deliverySubmissions = pgTable(
  "delivery_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    trackId: uuid("track_id").notNull().references(() => deliveryTracks.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    /** Null when the track does not pin a plan revision. */
    planRevisionId: uuid("plan_revision_id").references(() => documentRevisions.id, { onDelete: "cascade" }),
    repositoryUrl: text("repository_url").notNull(),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    submittedByAgentId: uuid("submitted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    submittedByUserId: text("submitted_by_user_id"),
    submittedByRunId: uuid("submitted_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Re-submitting the same candidate is idempotent rather than a duplicate. */
    candidateUq: uniqueIndex("delivery_submissions_candidate_uq").on(
      table.companyId,
      table.issueId,
      table.headSha,
    ),
    companyIssueCreatedIdx: index("delivery_submissions_company_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    trackIdx: index("delivery_submissions_track_idx").on(table.trackId),
  }),
);

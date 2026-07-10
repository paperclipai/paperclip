import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ImprovementSuggestionEvidence } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { feedbackVotes } from "./feedback_votes.js";
import { issues } from "./issues.js";

export const improvementSuggestions = pgTable(
  "improvement_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    originKind: text("origin_kind").notNull(),
    status: text("status").notNull(),
    targetLayer: text("target_layer").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    proposedChange: text("proposed_change").notNull(),
    evidence: jsonb("evidence").$type<ImprovementSuggestionEvidence[]>().notNull().default([]),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "set null" }),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    sourceFeedbackVoteId: uuid("source_feedback_vote_id").references(() => feedbackVotes.id, { onDelete: "set null" }),
    implementationIssueId: uuid("implementation_issue_id").references(() => issues.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("improvement_suggestions_company_status_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    companyOriginIdx: index("improvement_suggestions_company_origin_idx").on(
      table.companyId,
      table.originKind,
      table.createdAt,
    ),
    sourceIssueIdx: index("improvement_suggestions_source_issue_idx").on(
      table.companyId,
      table.sourceIssueId,
    ),
    sourceFeedbackVoteUniqueIdx: uniqueIndex("improvement_suggestions_source_feedback_vote_idx").on(
      table.sourceFeedbackVoteId,
    ),
    implementationIssueUniqueIdx: uniqueIndex("improvement_suggestions_implementation_issue_idx").on(
      table.implementationIssueId,
    ),
  }),
);

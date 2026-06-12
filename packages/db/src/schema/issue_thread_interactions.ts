import type {
  IssueThreadInteractionPayload,
  IssueThreadInteractionResult,
} from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";

export const issueThreadInteractions = pgTable(
  "issue_thread_interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    continuationPolicy: text("continuation_policy").notNull().default("wake_assignee"),
    idempotencyKey: text("idempotency_key"),
    sourceCommentId: uuid("source_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    title: text("title"),
    summary: text("summary"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    resolvedByAgentId: uuid("resolved_by_agent_id").references(() => agents.id),
    resolvedByUserId: text("resolved_by_user_id"),
    payload: jsonb("payload").$type<IssueThreadInteractionPayload>().notNull(),
    result: jsonb("result").$type<IssueThreadInteractionResult>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("issue_thread_interactions_issue_idx").on(table.issueId),
    companyIssueCreatedAtIdx: index("issue_thread_interactions_company_issue_created_at_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    companyIssueStatusIdx: index("issue_thread_interactions_company_issue_status_idx").on(
      table.companyId,
      table.issueId,
      table.status,
    ),
    companyIssueIdempotencyUq: uniqueIndex("issue_thread_interactions_company_issue_idempotency_uq")
      .on(table.companyId, table.issueId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    sourceCommentIdx: index("issue_thread_interactions_source_comment_idx").on(table.sourceCommentId),
  }),
);

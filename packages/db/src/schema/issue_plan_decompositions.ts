import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { documentRevisions } from "./document_revisions.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";
import { issues } from "./issues.js";

export const issuePlanDecompositions = pgTable(
  "issue_plan_decompositions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    acceptedPlanRevisionId: uuid("accepted_plan_revision_id")
      .notNull()
      .references(() => documentRevisions.id, { onDelete: "cascade" }),
    acceptedInteractionId: uuid("accepted_interaction_id")
      .references(() => issueThreadInteractions.id, { onDelete: "set null" }),
    status: text("status").notNull().default("in_flight"),
    requestFingerprint: text("request_fingerprint").notNull(),
    requestedChildCount: integer("requested_child_count").notNull().default(0),
    requestedChildren: jsonb("requested_children").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    childIssueIds: jsonb("child_issue_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ownerUserId: text("owner_user_id"),
    ownerRunId: uuid("owner_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceStatusIdx: index("issue_plan_decompositions_company_source_status_idx").on(
      table.companyId,
      table.sourceIssueId,
      table.status,
    ),
    activeOwnerIdx: index("issue_plan_decompositions_active_owner_idx")
      .on(table.companyId, table.ownerAgentId)
      .where(sql`${table.status} = 'in_flight'`),
    sourceRevisionUq: uniqueIndex("issue_plan_decompositions_source_revision_uq").on(
      table.companyId,
      table.sourceIssueId,
      table.acceptedPlanRevisionId,
    ),
  }),
);

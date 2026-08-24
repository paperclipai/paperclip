import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { documents } from "./documents.js";
import { documentRevisions } from "./document_revisions.js";

export const planReviewGates = pgTable(
  "plan_review_gates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => documentRevisions.id, { onDelete: "cascade" }),
    milestoneId: text("milestone_id"),
    status: text("status").notNull().default("pending"),
    acceptanceCriteria: jsonb("acceptance_criteria").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    assignedAgentId: uuid("assigned_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    resolvedByAgentId: uuid("resolved_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionComment: text("resolution_comment"),
    supersededByGateId: uuid("superseded_by_gate_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentRevisionIdx: index("plan_review_gates_document_revision_idx").on(
      table.companyId,
      table.documentId,
      table.revisionId,
    ),
    pendingGatesIdx: index("plan_review_gates_pending_idx")
      .on(table.companyId, table.documentId, table.revisionId)
      .where(sql`${table.status} = 'pending'`),
  }),
);

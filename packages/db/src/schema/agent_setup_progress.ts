import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export type AgentSetupProgressStatus = "waiting" | "in_progress" | "done" | "failed";
export type AgentSetupProgressItemStatus = "pending" | "in_progress" | "done" | "failed";
export interface AgentSetupProgressItemRecord {
  key: string;
  title: string;
  status: AgentSetupProgressItemStatus;
  detail: string | null;
}

/**
 * A checklist that a person's own agent (outside Paperclip, such as Claude Code
 * on their laptop) fills in while it sets something up for them. The setup page
 * creates one, hands the agent its URLs and a token in the setup prompt, and
 * shows the agent's updates live. Only the token's hash is stored, and the
 * token can do nothing but update this one checklist until it expires.
 */
export const agentSetupProgress = pgTable("agent_setup_progress", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  /** What is being set up, such as `aws_connection`; the page that created it reads it back. */
  purpose: text("purpose").notNull(),
  /** The thing being set up, such as a connection id. */
  subjectId: text("subject_id"),
  tokenHash: text("token_hash").notNull(),
  status: text("status").$type<AgentSetupProgressStatus>().notNull().default("waiting"),
  items: jsonb("items").$type<AgentSetupProgressItemRecord[]>().notNull().default([]),
  summary: text("summary"),
  updateCount: integer("update_count").notNull().default(0),
  createdByUserId: text("created_by_user_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyIdx: index("agent_setup_progress_company_idx").on(table.companyId),
  /** Cleanup removes checklists a day past expiry. */
  expiresIdx: index("agent_setup_progress_expires_idx").on(table.expiresAt),
  statusCheck: check(
    "agent_setup_progress_status_check",
    sql`${table.status} in ('waiting', 'in_progress', 'done', 'failed')`,
  ),
}));

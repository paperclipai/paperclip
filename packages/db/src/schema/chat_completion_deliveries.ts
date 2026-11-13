import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueComments } from "./issue_comments.js";

/** Server-derived audience captured when a conversation creates an execution task. */
export const chatTaskHandoffs = pgTable("chat_task_handoffs", {
  taskId: uuid("task_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  sessionGeneration: integer("session_generation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ sourceIdx: index("chat_task_handoffs_source_idx").on(t.companyId, t.conversationId) }));

/** Content-free outbox; results remain on the source task and its documents. */
export const chatCompletionDeliveries = pgTable("chat_completion_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => chatTaskHandoffs.taskId, { onDelete: "cascade" }),
  statusVersion: integer("status_version").notNull(),
  status: text("status").$type<"pending" | "queued" | "delivered" | "superseded" | "exhausted">().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  targetRunId: uuid("target_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
  responseCommentId: uuid("response_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  transitionUq: uniqueIndex("chat_completion_deliveries_transition_uq").on(t.taskId, t.statusVersion),
  pendingIdx: index("chat_completion_deliveries_pending_idx").on(t.status, t.nextAttemptAt),
}));

import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workflowRuns, workflowHandoffs } from "./workflows.js";

export const workflowHandoffBridges = pgTable(
  "workflow_handoff_bridges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    workflowHandoffId: uuid("workflow_handoff_id").notNull().references(() => workflowHandoffs.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    status: text("status")
      .notNull()
      .$type<"pending_delivery" | "waiting_for_human" | "closed" | "failed">()
      .default("pending_delivery"),
    closeOutcome: text("close_outcome")
      .$type<"responded" | "approved" | "rejected" | "expired" | "cancelled" | "failed" | null>(),
    externalMessageId: text("external_message_id"),
    externalThreadId: text("external_thread_id"),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    handoffActiveUq: uniqueIndex("workflow_handoff_bridges_handoff_active_uq")
      .on(table.workflowHandoffId)
      .where(sql`${table.status} in ('pending_delivery', 'waiting_for_human')`),
    companyPollIdx: index("workflow_handoff_bridges_company_poll_idx").on(
      table.companyId,
      table.status,
      table.nextPollAt,
    ),
  }),
);

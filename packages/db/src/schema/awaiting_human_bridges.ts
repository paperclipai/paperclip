import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";

export const awaitingHumanBridges = pgTable(
  "awaiting_human_bridges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    interactionId: uuid("interaction_id").notNull().references(() => issueThreadInteractions.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    provider: text("provider").notNull(),
    status: text("status")
      .notNull()
      .$type<"pending_delivery" | "waiting_for_human" | "closed" | "failed">()
      .default("pending_delivery"),
    closeOutcome: text("close_outcome")
      .$type<"approved" | "rejected" | "expired" | "superseded" | "cancelled" | null>(),
    externalThreadId: text("external_thread_id"),
    externalMessageId: text("external_message_id"),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    interactionActiveUq: uniqueIndex("awaiting_human_bridges_interaction_active_uq")
      .on(table.interactionId)
      .where(sql`${table.status} in ('pending_delivery', 'waiting_for_human')`),
    interactionStatusIdx: index("awaiting_human_bridges_interaction_status_idx").on(
      table.interactionId,
      table.status,
    ),
    companyPollIdx: index("awaiting_human_bridges_company_poll_idx").on(
      table.companyId,
      table.status,
      table.nextPollAt,
    ),
  }),
);

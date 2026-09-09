import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";

/** Content-free outbox; the interaction holds the authoritative result and audience. */
export const connectionIntentDeliveries = pgTable("connection_intent_deliveries", {
  interactionId: uuid("interaction_id").primaryKey().references(() => issueThreadInteractions.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({ pendingIdx: index("connection_intent_deliveries_pending_idx").on(table.deliveredAt, table.nextAttemptAt) }));

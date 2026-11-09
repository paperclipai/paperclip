import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";
import { toolActionRequests } from "./tool_access.js";

/** Content-free outbox: one continuation for each authoritative review outcome. */
export const toolActionDeliveries = pgTable(
  "tool_action_deliveries",
  {
    actionRequestId: uuid("action_request_id")
      .primaryKey()
      .references(() => toolActionRequests.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => issueThreadInteractions.id, { onDelete: "cascade" }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("tool_action_deliveries_pending_idx").on(
      table.deliveredAt,
      table.createdAt,
    ),
  ],
);

import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { webhookEndpoints } from "./webhook_endpoints.js";

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: text("payload").notNull(),
    responseCode: integer("response_code"),
    responseBody: text("response_body"),
    errorMessage: text("error_message"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    endpointIdx: index("webhook_deliveries_endpoint_idx").on(table.endpointId),
    createdAtIdx: index("webhook_deliveries_created_at_idx").on(table.createdAt),
  }),
);

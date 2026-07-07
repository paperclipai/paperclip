import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const webPushSubscriptions = pgTable(
  "web_push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    deviceLabel: text("device_label").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    endpointIdx: uniqueIndex("web_push_subscriptions_company_endpoint_idx").on(table.companyId, table.endpoint),
    companyIdx: index("web_push_subscriptions_company_idx").on(table.companyId),
    createdAtIdx: index("web_push_subscriptions_created_at_idx").on(table.createdAt),
  }),
);

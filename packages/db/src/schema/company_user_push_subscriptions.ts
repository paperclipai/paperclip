import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyUserPushSubscriptions = pgTable(
  "company_user_push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    companyIdx: index("company_user_push_subscriptions_company_idx").on(table.companyId),
    userIdx: index("company_user_push_subscriptions_user_idx").on(table.userId),
    endpointUq: uniqueIndex("company_user_push_subscriptions_endpoint_uq").on(table.endpoint),
  }),
);

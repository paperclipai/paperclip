import { pgTable, text, timestamp, uniqueIndex, uuid, index } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

export const webPushSubscriptions = pgTable(
  "web_push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userEndpointUniqueIdx: uniqueIndex("web_push_subscriptions_user_endpoint_idx").on(
      table.userId,
      table.endpoint,
    ),
    userIdx: index("web_push_subscriptions_user_idx").on(table.userId),
  }),
);

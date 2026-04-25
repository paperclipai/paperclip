import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  real,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const subscriptionQuotas = pgTable(
  "subscription_quotas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscription: text("subscription").notNull(),
    provider: text("provider").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    usedMessages: integer("used_messages").notNull().default(0),
    usedTokens: bigint("used_tokens", { mode: "number" }).notNull().default(0),
    capacityMessages: integer("capacity_messages").notNull(),
    capacityTokens: bigint("capacity_tokens", { mode: "number" }).notNull(),
    utilizationCap: real("utilization_cap").notNull().default(0.70),
    isSaturated: boolean("is_saturated").notNull().default(false),
    lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subscriptionIdx: index("subscription_quotas_subscription_idx").on(table.subscription),
    windowIdx: index("subscription_quotas_window_idx").on(table.windowStart, table.windowEnd),
    saturatedIdx: index("subscription_quotas_saturated_idx").on(table.subscription, table.isSaturated),
    subscriptionWindowUnique: index("subscription_quotas_subscription_window_unique").on(
      table.subscription,
      table.windowStart,
    ),
  }),
);

export type SubscriptionQuota = typeof subscriptionQuotas.$inferSelect;
export type NewSubscriptionQuota = typeof subscriptionQuotas.$inferInsert;
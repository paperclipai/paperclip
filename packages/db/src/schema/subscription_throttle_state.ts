import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const subscriptionThrottleState = pgTable(
  "subscription_throttle_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    throttleActive: boolean("throttle_active").notNull().default(false),
    usagePercent: text("usage_percent").notNull().default("0"),
    since: timestamp("since", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProviderIdx: uniqueIndex("subscription_throttle_state_company_provider_idx").on(
      table.companyId,
      table.provider,
    ),
  }),
);

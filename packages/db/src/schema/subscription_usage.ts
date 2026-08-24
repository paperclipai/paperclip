import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySubscriptions } from "./company_subscriptions.js";

export const subscriptionUsage = pgTable(
  "subscription_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    subscriptionId: uuid("subscription_id").notNull().references(() => companySubscriptions.id),
    metric: text("metric").notNull(),
    usage: integer("usage").notNull().default(0),
    included: integer("included").notNull().default(0),
    overage: integer("overage").notNull().default(0),
    overageCents: integer("overage_cents").notNull().default(0),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    stripeUsageRecordId: text("stripe_usage_record_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPeriodIdx: index("subscription_usage_company_period_idx").on(table.companyId, table.periodStart, table.periodEnd),
    subscriptionMetricPeriodIdx: uniqueIndex("subscription_usage_sub_metric_period_idx").on(
      table.subscriptionId,
      table.metric,
      table.periodStart,
      table.periodEnd,
    ),
  }),
);

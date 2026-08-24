import { pgTable, uuid, text, integer, boolean, timestamp, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { subscriptionTiers } from "./subscription_tiers.js";
import { stripeCustomers } from "./stripe_customers.js";

export const companySubscriptions = pgTable(
  "company_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    tierId: uuid("tier_id").notNull().references(() => subscriptionTiers.id),
    stripeCustomerId: uuid("stripe_customer_id").notNull().references(() => stripeCustomers.id),
    status: text("status").notNull().default("active"),
    billingPeriod: text("billing_period").notNull().default("monthly"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripeSubscriptionItemId: text("stripe_subscription_item_id"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    trialEnd: timestamp("trial_end", { withTimezone: true }),
    metadataJson: text("metadata_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_subscriptions_company_idx").on(table.companyId),
    companyUniqueIdx: unique("company_subscriptions_company_unique_idx").on(table.companyId),
    stripeSubscriptionIdx: uniqueIndex("company_subscriptions_stripe_subscription_idx").on(table.stripeSubscriptionId),
  }),
);

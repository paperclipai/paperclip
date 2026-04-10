import { pgTable, uuid, text, integer, bigint, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

export const subscriptionPlans = pgTable("subscription_plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  stripePriceId: text("stripe_price_id"),
  monthlyPriceCents: integer("monthly_price_cents").notNull().default(0),
  maxAgents: integer("max_agents"),
  maxCompanies: integer("max_companies"),
  maxMonthlyCostCents: integer("max_monthly_cost_cents"),
  maxStorageBytes: bigint("max_storage_bytes", { mode: "number" }),
  maxIssues: integer("max_issues"),
  maxProjects: integer("max_projects"),
  features: text("features"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  scope: text("scope").notNull().default("company"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const companySubscriptions = pgTable(
  "company_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    planId: text("plan_id").notNull().references(() => subscriptionPlans.id),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    status: text("status").notNull().default("active"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    trialWarningSentAt: timestamp("trial_warning_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUniqueIdx: uniqueIndex("company_subscriptions_company_idx").on(table.companyId),
    stripeCustomerIdx: index("company_subscriptions_stripe_customer_idx").on(table.stripeCustomerId),
    stripeSubscriptionIdx: index("company_subscriptions_stripe_subscription_idx").on(table.stripeSubscriptionId),
  }),
);

export const accountSubscriptions = pgTable(
  "account_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id),
    planId: text("plan_id").notNull().references(() => subscriptionPlans.id),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    status: text("status").notNull().default("active"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userUniqueIdx: uniqueIndex("account_subscriptions_user_idx").on(table.userId),
    stripeCustomerIdx: index("account_subscriptions_stripe_customer_idx").on(table.stripeCustomerId),
    stripeSubscriptionIdx: index("account_subscriptions_stripe_subscription_idx").on(table.stripeSubscriptionId),
  }),
);

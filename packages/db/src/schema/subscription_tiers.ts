import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const subscriptionTiers = pgTable(
  "subscription_tiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    priceMonthlyCents: integer("price_monthly_cents").notNull().default(0),
    priceYearlyCents: integer("price_yearly_cents").notNull().default(0),
    stripePriceMonthlyId: text("stripe_price_monthly_id"),
    stripePriceYearlyId: text("stripe_price_yearly_id"),
    stripeProductId: text("stripe_product_id"),
    includedSeats: integer("included_seats").notNull().default(0),
    extraSeatPriceCents: integer("extra_seat_price_cents").notNull().default(0),
    includedAgentRuns: integer("included_agent_runs").notNull().default(0),
    extraAgentRunPriceCents: integer("extra_agent_run_price_cents").notNull().default(0),
    includedStorageGb: integer("included_storage_gb").notNull().default(0),
    extraStorageGbPriceCents: integer("extra_storage_gb_price_cents").notNull().default(0),
    features: jsonb("features").$type<string[]>().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameUniqueIdx: uniqueIndex("subscription_tiers_name_idx").on(table.name),
  }),
);

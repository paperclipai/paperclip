import { pgTable, uuid, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Per-company billing configuration for usage-based (per-token) billing. The platform owner sets
// a markup over the raw provider cost; statements roll up cost_events for a period and apply it.
// stripeCustomerId is reserved for the follow-up Stripe payment wiring (null until then).
export const billingAccounts = pgTable(
  "billing_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // Markup over raw provider cost, in basis points. 0 = at-cost, 2000 = +20%.
    markupBps: integer("markup_bps").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    billingEmail: text("billing_email"),
    stripeCustomerId: text("stripe_customer_id"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUniqueIdx: uniqueIndex("billing_accounts_company_unique_idx").on(table.companyId),
  }),
);

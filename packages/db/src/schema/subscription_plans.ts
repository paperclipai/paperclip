import { pgTable, uuid, text, timestamp, integer, index, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const subscriptionPlans = pgTable(
  "subscription_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    provider: text("provider").notNull(),
    biller: text("biller").notNull(),
    monthlyCostCents: integer("monthly_cost_cents").notNull(),
    seatCount: integer("seat_count").notNull().default(1),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyActiveIdx: index("subscription_plans_company_active_idx").on(table.companyId, table.isActive),
    companyProviderIdx: index("subscription_plans_company_provider_idx").on(
      table.companyId,
      table.provider,
      table.biller,
    ),
    companyAgentIdx: index("subscription_plans_company_agent_idx").on(table.companyId, table.agentId),
  }),
);

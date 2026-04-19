import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const creditBurnRates = pgTable("credit_burn_rates", {
  actionType: text("action_type").primaryKey(),
  creditsMin: integer("credits_min").notNull(),
  creditsMax: integer("credits_max").notNull(),
  creditsDefault: integer("credits_default").notNull(),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

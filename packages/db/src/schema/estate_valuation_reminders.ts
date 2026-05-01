import { pgEnum, pgTable, uuid, text, timestamp, boolean, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { estateAssets } from "./estate_assets.js";

export const valuationReminderFrequencyEnum = pgEnum("valuation_reminder_frequency", [
  "monthly",
  "quarterly",
  "semi_annual",
  "annual",
  "custom",
]);

export const estateValuationReminders = pgTable(
  "estate_valuation_reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id").notNull().references(() => estateAssets.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    frequency: valuationReminderFrequencyEnum("frequency").notNull().default("annual"),
    frequencyDays: integer("frequency_days").notNull().default(365),
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    assetIdx: index("estate_val_reminders_asset_idx").on(table.assetId),
    companyUserIdx: index("estate_val_reminders_company_user_idx").on(table.companyId, table.userId),
  }),
);

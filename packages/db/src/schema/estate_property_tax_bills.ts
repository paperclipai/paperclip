import { pgEnum, pgTable, uuid, text, timestamp, numeric, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { estateAssets } from "./estate_assets.js";

export const propertyTaxStatusEnum = pgEnum("property_tax_status", [
  "upcoming",
  "paid",
  "overdue",
  "exempt",
]);

export const estatePropertyTaxBills = pgTable(
  "estate_property_tax_bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id").notNull().references(() => estateAssets.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    state: text("state").notNull(),
    county: text("county"),
    taxYear: integer("tax_year").notNull(),
    installment: integer("installment").notNull().default(1),
    dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
    amountCents: numeric("amount_cents", { precision: 20, scale: 0 }),
    status: propertyTaxStatusEnum("status").notNull().default("upcoming"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidAmountCents: numeric("paid_amount_cents", { precision: 20, scale: 0 }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    assetIdx: index("estate_prop_tax_asset_idx").on(table.assetId),
    companyUserIdx: index("estate_prop_tax_company_user_idx").on(table.companyId, table.userId),
    stateYearIdx: index("estate_prop_tax_state_year_idx").on(table.companyId, table.state, table.taxYear),
  }),
);

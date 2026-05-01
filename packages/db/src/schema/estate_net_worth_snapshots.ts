import { pgTable, uuid, text, timestamp, numeric, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const estateNetWorthSnapshots = pgTable(
  "estate_net_worth_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    snapshotDate: timestamp("snapshot_date", { withTimezone: true }).notNull(),
    netWorthCents: numeric("net_worth_cents", { precision: 20, scale: 0 }).notNull(),
    assetsTotalCents: numeric("assets_total_cents", { precision: 20, scale: 0 }).notNull(),
    accountsTotalCents: numeric("accounts_total_cents", { precision: 20, scale: 0 }).notNull(),
    // Breakdown by asset type for charting
    breakdown: jsonb("breakdown").$type<Record<string, number>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserDateIdx: index("estate_nw_snapshots_company_user_date_idx").on(
      table.companyId,
      table.userId,
      table.snapshotDate,
    ),
  }),
);

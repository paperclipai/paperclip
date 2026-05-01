import { pgEnum, pgTable, uuid, text, timestamp, numeric, boolean, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { estateAssets } from "./estate_assets.js";

export const taxLotStatusEnum = pgEnum("tax_lot_status", [
  "open",
  "closed",
  "transferred",
]);

export const estateTaxLots = pgTable(
  "estate_tax_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id").notNull().references(() => estateAssets.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    // Security identification
    ticker: text("ticker"),
    cusip: text("cusip"),
    securityName: text("security_name"),
    // Lot details
    shares: numeric("shares", { precision: 20, scale: 8 }).notNull(),
    costBasisPerShareCents: numeric("cost_basis_per_share_cents", { precision: 20, scale: 4 }).notNull(),
    totalCostBasisCents: numeric("total_cost_basis_cents", { precision: 20, scale: 0 }).notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
    // Current mark
    currentPricePerShareCents: numeric("current_price_per_share_cents", { precision: 20, scale: 4 }),
    currentValueCents: numeric("current_value_cents", { precision: 20, scale: 0 }),
    // Disposition
    status: taxLotStatusEnum("status").notNull().default("open"),
    soldAt: timestamp("sold_at", { withTimezone: true }),
    salePerShareCents: numeric("sale_per_share_cents", { precision: 20, scale: 4 }),
    // Short-term if held < 1 year
    isLongTerm: boolean("is_long_term").notNull().default(false),
    // Wash sale tracking
    isWashSale: boolean("is_wash_sale").notNull().default(false),
    washSaleDisallowedCents: numeric("wash_sale_disallowed_cents", { precision: 20, scale: 0 }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    assetIdx: index("estate_tax_lots_asset_idx").on(table.assetId),
    companyUserIdx: index("estate_tax_lots_company_user_idx").on(table.companyId, table.userId),
    tickerIdx: index("estate_tax_lots_ticker_idx").on(table.companyId, table.ticker),
    statusIdx: index("estate_tax_lots_status_idx").on(table.companyId, table.status),
  }),
);

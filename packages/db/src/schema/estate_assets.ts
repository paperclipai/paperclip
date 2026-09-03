import { pgEnum, pgTable, uuid, text, timestamp, numeric, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { estates } from "./estates.js";

export const estateAssetTypeEnum = pgEnum("estate_asset_type", [
  "real_estate",
  "investment",
  "vehicle",
  "personal_property",
  "digital_asset",
  "other",
]);

export const estateAssets = pgTable(
  "estate_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    assetType: estateAssetTypeEnum("asset_type").notNull(),
    category: text("category"),
    tags: text("tags").array(),
    entityId: text("entity_id"),
    currentValueCents: numeric("current_value_cents", { precision: 20, scale: 0 }),
    valuationDate: timestamp("valuation_date", { withTimezone: true }),
    // Type-specific metadata: address/sqft for real_estate; ticker/shares for investment; etc.
    typeMetadata: jsonb("type_metadata").$type<Record<string, unknown>>(),
    estateId: uuid("estate_id").references(() => estates.id, { onDelete: "set null" }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("estate_assets_company_user_idx").on(table.companyId, table.userId),
    companyTypeIdx: index("estate_assets_company_type_idx").on(table.companyId, table.assetType),
    entityIdx: index("estate_assets_entity_idx").on(table.entityId),
    estateIdx: index("estate_assets_estate_idx").on(table.estateId),
  }),
);

import { pgTable, uuid, text, boolean, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { assets } from "./assets.js";

// Brand kit library (NEO-268): multiple kits per company, exactly one default.
// design_md is the canonical DESIGN.md artifact (NEO-267); tokens is the parsed cache.
export const brandKits = pgTable(
  "brand_kits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    designMd: text("design_md").notNull().default(""),
    tokens: jsonb("tokens").$type<Record<string, unknown>>().notNull().default({}),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("brand_kits_company_idx").on(table.companyId),
    companySlugUq: uniqueIndex("brand_kits_company_slug_uq").on(table.companyId, table.slug),
    // Exactly one default kit per company.
    companyDefaultUq: uniqueIndex("brand_kits_company_default_uq")
      .on(table.companyId)
      .where(sql`${table.isDefault} = true`),
  }),
);

// Junction over assets. role is one of the shared brand-kit asset roles:
// logo_primary | logo_mark | logo_mono | font:<family>:<weight>
export const brandKitAssets = pgTable(
  "brand_kit_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandKitId: uuid("brand_kit_id").notNull().references(() => brandKits.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    kitRoleUq: uniqueIndex("brand_kit_assets_kit_role_uq").on(table.brandKitId, table.role),
    assetIdx: index("brand_kit_assets_asset_idx").on(table.assetId),
  }),
);

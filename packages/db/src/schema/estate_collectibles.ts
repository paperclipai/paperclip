import { pgEnum, pgTable, uuid, text, timestamp, numeric, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { estateAssets } from "./estate_assets.js";

export const collectibleTypeEnum = pgEnum("collectible_type", [
  "art",
  "jewelry",
  "wine_spirits",
  "coins_bullion",
  "stamps",
  "vintage_vehicle",
  "antiques",
  "sports_memorabilia",
  "watches",
  "other",
]);

export const estateCollectibles = pgTable(
  "estate_collectibles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id").notNull().references(() => estateAssets.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    collectibleType: collectibleTypeEnum("collectible_type").notNull().default("art"),
    // Attribution / origin
    artist: text("artist"),
    maker: text("maker"),
    yearCreated: text("year_created"),
    medium: text("medium"),
    dimensions: text("dimensions"),
    condition: text("condition"),
    // Provenance & authentication
    provenanceDocIds: text("provenance_doc_ids").array(),
    authCertDocIds: text("auth_cert_doc_ids").array(),
    // Insurance
    insuranceRiderDocIds: text("insurance_rider_doc_ids").array(),
    insuredValueCents: numeric("insured_value_cents", { precision: 20, scale: 0 }),
    // Appraisal
    lastAppraisalValueCents: numeric("last_appraisal_value_cents", { precision: 20, scale: 0 }),
    lastAppraisalDate: timestamp("last_appraisal_date", { withTimezone: true }),
    appraisalDocIds: text("appraisal_doc_ids").array(),
    // Storage
    storageFacility: text("storage_facility"),
    storageLocation: text("storage_location"),
    // Additional metadata
    additionalInfo: jsonb("additional_info").$type<Record<string, unknown>>(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    assetIdx: index("estate_collectibles_asset_idx").on(table.assetId),
    companyUserIdx: index("estate_collectibles_company_user_idx").on(table.companyId, table.userId),
    typeIdx: index("estate_collectibles_type_idx").on(table.companyId, table.collectibleType),
  }),
);

import { pgEnum, pgTable, uuid, text, timestamp, numeric, boolean, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { estateAssets } from "./estate_assets.js";

export const businessEntityTypeEnum = pgEnum("business_entity_type", [
  "llc",
  "s_corp",
  "c_corp",
  "partnership",
  "sole_proprietorship",
  "lp",
  "llp",
  "other",
]);

export const estateBusinessInterests = pgTable(
  "estate_business_interests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id").notNull().references(() => estateAssets.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    businessName: text("business_name").notNull(),
    entityType: businessEntityTypeEnum("entity_type").notNull().default("llc"),
    ownershipPct: numeric("ownership_pct", { precision: 7, scale: 4 }),
    ein: text("ein"),
    state: text("state"),
    // Appraisal workflow
    lastAppraisalValueCents: numeric("last_appraisal_value_cents", { precision: 20, scale: 0 }),
    lastAppraisalDate: timestamp("last_appraisal_date", { withTimezone: true }),
    nextAppraisalDueDate: timestamp("next_appraisal_due_date", { withTimezone: true }),
    appraisalDocIds: text("appraisal_doc_ids").array(),
    // Buy-sell agreement
    hasBuySellAgreement: boolean("has_buy_sell_agreement").notNull().default(false),
    buySellAgreementDocId: text("buy_sell_agreement_doc_id"),
    buySellTriggers: jsonb("buy_sell_triggers").$type<string[]>(),
    // Key-person insurance
    hasKeyPersonInsurance: boolean("has_key_person_insurance").notNull().default(false),
    keyPersonInsurancePolicyIds: text("key_person_insurance_policy_ids").array(),
    // Co-owners
    coOwners: jsonb("co_owners").$type<Array<{ name: string; ownershipPct: number; contactInfo?: string }>>(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    assetIdx: index("estate_business_asset_idx").on(table.assetId),
    companyUserIdx: index("estate_business_company_user_idx").on(table.companyId, table.userId),
    appraisalDueIdx: index("estate_business_appraisal_due_idx").on(table.companyId, table.nextAppraisalDueDate),
  }),
);

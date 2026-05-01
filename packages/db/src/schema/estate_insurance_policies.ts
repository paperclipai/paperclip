import { pgEnum, pgTable, uuid, text, timestamp, numeric, boolean, index, jsonb, integer } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { estateAssets } from "./estate_assets.js";

export const insurancePolicyTypeEnum = pgEnum("insurance_policy_type", [
  "term",
  "whole_life",
  "universal_life",
  "variable_life",
  "annuity",
  "other",
]);

export const premiumFrequencyEnum = pgEnum("premium_frequency", [
  "monthly",
  "quarterly",
  "semi_annual",
  "annual",
]);

export const estateInsurancePolicies = pgTable(
  "estate_insurance_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id").notNull().references(() => estateAssets.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    policyNumber: text("policy_number"),
    insurer: text("insurer"),
    policyType: insurancePolicyTypeEnum("policy_type").notNull().default("term"),
    deathBenefitCents: numeric("death_benefit_cents", { precision: 20, scale: 0 }),
    cashValueCents: numeric("cash_value_cents", { precision: 20, scale: 0 }),
    premiumAmountCents: numeric("premium_amount_cents", { precision: 20, scale: 0 }),
    premiumFrequency: premiumFrequencyEnum("premium_frequency"),
    premiumNextDueAt: timestamp("premium_next_due_at", { withTimezone: true }),
    // ILIT (Irrevocable Life Insurance Trust) linkage
    ilitTrustName: text("ilit_trust_name"),
    ilitTrustEntityId: text("ilit_trust_entity_id"),
    outstandingLoanCents: numeric("outstanding_loan_cents", { precision: 20, scale: 0 }),
    beneficiaries: jsonb("beneficiaries").$type<Array<{ name: string; relationship: string; percentage: number; isPrimary: boolean }>>(),
    documentIds: text("document_ids").array(),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    assetIdx: index("estate_insurance_asset_idx").on(table.assetId),
    companyUserIdx: index("estate_insurance_company_user_idx").on(table.companyId, table.userId),
  }),
);

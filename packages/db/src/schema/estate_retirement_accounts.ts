import { pgEnum, pgTable, uuid, text, timestamp, numeric, boolean, index, jsonb, integer } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { estateAssets } from "./estate_assets.js";

export const retirementAccountTypeEnum = pgEnum("retirement_account_type", [
  "traditional_ira",
  "roth_ira",
  "401k",
  "roth_401k",
  "403b",
  "roth_403b",
  "sep_ira",
  "simple_ira",
  "pension",
  "457b",
  "other",
]);

export const estateRetirementAccounts = pgTable(
  "estate_retirement_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id").notNull().references(() => estateAssets.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    accountType: retirementAccountTypeEnum("account_type").notNull().default("traditional_ira"),
    isRoth: boolean("is_roth").notNull().default(false),
    custodian: text("custodian"),
    accountNumber: text("account_number"),
    // Contribution tracking
    annualContributionLimitCents: numeric("annual_contribution_limit_cents", { precision: 20, scale: 0 }),
    ytdContributionCents: numeric("ytd_contribution_cents", { precision: 20, scale: 0 }),
    // RMD (Required Minimum Distribution)
    rmdRequired: boolean("rmd_required").notNull().default(false),
    rmdAmountCents: numeric("rmd_amount_cents", { precision: 20, scale: 0 }),
    rmdDueYear: integer("rmd_due_year"),
    rmdWithdrawnThisYearCents: numeric("rmd_withdrawn_this_year_cents", { precision: 20, scale: 0 }),
    // Beneficiaries
    primaryBeneficiaries: jsonb("primary_beneficiaries").$type<Array<{ name: string; relationship: string; percentage: number; ssn?: string }>>(),
    contingentBeneficiaries: jsonb("contingent_beneficiaries").$type<Array<{ name: string; relationship: string; percentage: number; ssn?: string }>>(),
    documentIds: text("document_ids").array(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    assetIdx: index("estate_retirement_asset_idx").on(table.assetId),
    companyUserIdx: index("estate_retirement_company_user_idx").on(table.companyId, table.userId),
    rmdIdx: index("estate_retirement_rmd_idx").on(table.companyId, table.rmdRequired, table.rmdDueYear),
  }),
);

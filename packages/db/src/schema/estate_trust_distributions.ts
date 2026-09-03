import { pgEnum, pgTable, uuid, text, integer, date, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { estateTrusts } from "./estate_trusts.js";
import { estateBeneficiaries } from "./estate_beneficiaries.js";

export const distributionTypeEnum = pgEnum("distribution_type", [
  "income",
  "principal",
  "discretionary",
  "mandatory",
]);

export const estateTrustDistributions = pgTable(
  "estate_trust_distributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trustId: uuid("trust_id").notNull().references(() => estateTrusts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    beneficiaryId: uuid("beneficiary_id").references(() => estateBeneficiaries.id, { onDelete: "set null" }),
    beneficiaryName: text("beneficiary_name"),
    amountCents: integer("amount_cents").notNull(),
    distributionDate: date("distribution_date").notNull(),
    distributionType: distributionTypeEnum("distribution_type").notNull().default("discretionary"),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    trustIdx: index("estate_trust_distributions_trust_idx").on(table.trustId),
    companyIdx: index("estate_trust_distributions_company_idx").on(table.companyId),
    amountCheck: check("amount_cents_positive", sql`${table.amountCents} > 0`),
  }),
);

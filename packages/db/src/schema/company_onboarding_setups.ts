import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export type CompanyOnboardingSetupItem = {
  key: string;
  label: string;
  status: "pending" | "deferred" | "completed";
  href?: string;
};

export const companyOnboardingSetups = pgTable(
  "company_onboarding_setups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    starterIssueId: uuid("starter_issue_id").references(() => issues.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    source: text("source").notNull().default("first_run"),
    items: jsonb("items").$type<CompanyOnboardingSetupItem[]>().notNull().default(sql`'[]'::jsonb`),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUniqueIdx: uniqueIndex("company_onboarding_setups_company_uq").on(table.companyId),
    companyStatusIdx: index("company_onboarding_setups_company_status_idx").on(table.companyId, table.status),
  }),
);

import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyStaffProfiles = pgTable(
  "company_staff_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    jobTitle: text("job_title"),
    orgRole: text("org_role"),
    capabilities: text("capabilities"),
    reportsToPrincipalType: text("reports_to_principal_type"),
    reportsToPrincipalId: text("reports_to_principal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserUniqueIdx: uniqueIndex("company_staff_profiles_company_user_unique_idx").on(
      table.companyId,
      table.userId,
    ),
    companyReportsIdx: index("company_staff_profiles_company_reports_idx").on(
      table.companyId,
      table.reportsToPrincipalType,
      table.reportsToPrincipalId,
    ),
  }),
);

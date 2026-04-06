import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
export const bugReports = pgTable(
  "bug_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id),
    reportedByUserId: text("reported_by_user_id"),
    type: text("type").notNull().default("bug"),
    title: text("title").notNull(),
    description: text("description"),
    pageUrl: text("page_url"),
    severity: text("severity").default("medium"),
    status: text("status").notNull().default("open"),
    adminNotes: text("admin_notes"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("bug_reports_company_idx").on(table.companyId),
    statusIdx: index("bug_reports_status_idx").on(table.status),
  }),
);

import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueFavourites = pgTable(
  "issue_favourites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("issue_favourites_company_user_idx").on(table.companyId, table.userId),
    companyIssueIdx: index("issue_favourites_company_issue_idx").on(table.companyId, table.issueId),
    companyIssueUserUnique: uniqueIndex("issue_favourites_company_issue_user_idx").on(
      table.companyId,
      table.issueId,
      table.userId,
    ),
  }),
);

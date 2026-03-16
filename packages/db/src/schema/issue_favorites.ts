import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * Tracks user favorites for issues.
 * Each user can favorite any issue within their company scope.
 * Favorites are user-specific and can be used to quickly access starred issues.
 */
export const issueFavorites = pgTable(
  "issue_favorites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Index for listing favorites by company + user (most common query)
    companyUserIdx: index("issue_favorites_company_user_idx").on(table.companyId, table.userId),
    // Index for checking if a specific issue is favorited
    companyIssueIdx: index("issue_favorites_company_issue_idx").on(table.companyId, table.issueId),
    // Ensure each user can only favorite an issue once
    companyIssueUserUnique: uniqueIndex("issue_favorites_company_issue_user_idx").on(
      table.companyId,
      table.issueId,
      table.userId,
    ),
  }),
);

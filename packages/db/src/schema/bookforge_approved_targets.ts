import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const bookforgeApprovedTargets = pgTable(
  "bookforge_approved_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("proposed_stale_check_needed"),
    yaml: text("yaml"),
    itemId: text("item_id"),
    projectName: text("project_name"),
    bookTitle: text("book_title"),
    budgetCapCents: text("budget_cap_cents"),
    qualityThreshold: text("quality_threshold"),
    resumeAllowed: text("resume_allowed").notNull().default("false"),
    approvedBy: text("approved_by"),
    approvalIssueId: text("approval_issue_id"),
    approvalCommentId: text("approval_comment_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    mismatchDetails: text("mismatch_details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("bookforge_approved_targets_company_status_idx").on(table.companyId, table.status),
    companyUpdatedIdx: index("bookforge_approved_targets_company_updated_idx").on(table.companyId, table.updatedAt),
  }),
);

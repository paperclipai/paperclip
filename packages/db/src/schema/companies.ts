import { pgTable, uuid, text, integer, timestamp, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    issuePrefix: text("issue_prefix").notNull().default("PAP"),
    issueCounter: integer("issue_counter").notNull().default(0),
    // Source of truth for this company's issue identifiers.
    //   "paperclip" → identifiers minted from issuePrefix + issueCounter (default).
    //   "linear"    → identifiers minted by Linear and mirrored back via the
    //                 paperclip-plugin-linear adapter at create-time.
    // Per-company opt-in (see plan: linear-id-unification.md). Companies stay
    // on "paperclip" until they're explicitly migrated; flipping requires
    // first re-prefixing pre-existing paperclip-only issues to PCL- so the
    // BLO-N namespace can be ceded to Linear cleanly. The CHECK constraint
    // lives in the migration SQL — Drizzle's text() doesn't track it.
    identifierProvider: text("identifier_provider").notNull().default("paperclip"),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    attachmentMaxBytes: integer("attachment_max_bytes")
      .notNull()
      .default(10 * 1024 * 1024),
    requireBoardApprovalForNewAgents: boolean("require_board_approval_for_new_agents")
      .notNull()
      .default(false),
    feedbackDataSharingEnabled: boolean("feedback_data_sharing_enabled")
      .notNull()
      .default(false),
    featureFlags: jsonb("feature_flags").$type<{
      serverSideSweepPreflight?: boolean;
    }>().notNull().default({}),
    feedbackDataSharingConsentAt: timestamp("feedback_data_sharing_consent_at", { withTimezone: true }),
    feedbackDataSharingConsentByUserId: text("feedback_data_sharing_consent_by_user_id"),
    feedbackDataSharingTermsVersion: text("feedback_data_sharing_terms_version"),
    brandColor: text("brand_color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePrefixUniqueIdx: uniqueIndex("companies_issue_prefix_idx").on(table.issuePrefix),
  }),
);

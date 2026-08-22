import type { InteractionResolverGovernance } from "@paperclipai/shared";
import { type AnyPgColumn, pgTable, uuid, text, integer, timestamp, boolean, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

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
    parentCompanyId: uuid("parent_company_id").references((): AnyPgColumn => companies.id, { onDelete: "set null" }),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    emergencyStopState: jsonb("emergency_stop_state").$type<Record<string, unknown>>().notNull().default({}),
    strandedRecoveryOwnerAgentId: uuid("stranded_recovery_owner_agent_id"),
    activityWindow: jsonb("activity_window").$type<Record<string, unknown>>(),
    activityWindowState: jsonb("activity_window_state").$type<Record<string, unknown>>().notNull().default({}),
    runPauseState: jsonb("run_pause_state").$type<Record<string, unknown>>().notNull().default({}),
    routineGuardConfig: jsonb("routine_guard_config").$type<Record<string, unknown>>().notNull().default({}),
    attachmentMaxBytes: integer("attachment_max_bytes")
      .notNull()
      .default(10 * 1024 * 1024),
    defaultResponsibleUserId: text("default_responsible_user_id"),
    requireBoardApprovalForNewAgents: boolean("require_board_approval_for_new_agents")
      .notNull()
      .default(false),
    interactionResolverGovernance: jsonb("interaction_resolver_governance")
      .$type<InteractionResolverGovernance>()
      .notNull()
      .default({}),
    feedbackDataSharingEnabled: boolean("feedback_data_sharing_enabled")
      .notNull()
      .default(false),
    feedbackDataSharingConsentAt: timestamp("feedback_data_sharing_consent_at", { withTimezone: true }),
    feedbackDataSharingConsentByUserId: text("feedback_data_sharing_consent_by_user_id"),
    feedbackDataSharingTermsVersion: text("feedback_data_sharing_terms_version"),
    brandColor: text("brand_color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePrefixUniqueIdx: uniqueIndex("companies_issue_prefix_idx").on(table.issuePrefix),
    parentCompanyIdx: index("companies_parent_company_id_idx").on(table.parentCompanyId),
  }),
);

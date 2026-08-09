import type { InteractionResolverGovernance } from "@paperclipai/shared";
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
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    attachmentMaxBytes: integer("attachment_max_bytes")
      .notNull()
      .default(10 * 1024 * 1024),
    defaultResponsibleUserId: text("default_responsible_user_id"),
    requireBoardApprovalForNewAgents: boolean("require_board_approval_for_new_agents")
      .notNull()
      .default(false),
    // TECH-4930 stage 2: gates the agent-ownership enforcement added in
    // server/src/services/authorization.ts (applyAgentOwnershipEnforcement).
    // Defaults to false so existing companies see byte-identical behavior
    // until an admin opts in. Enabling is refused by
    // agentOwnershipService(db).assertReadyToEnableEnforcement() (called
    // from companyService.update) whenever any agent in the company has
    // zero active owner grants -- see agent_ownership_grants.ts for why
    // agents created before TECH-4929 shipped may have none.
    enforceAgentOwnership: boolean("enforce_agent_ownership")
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
  }),
);

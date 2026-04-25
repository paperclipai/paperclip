import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const prReviewStates = pgTable(
  "pr_review_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    repositoryFullName: text("repository_full_name").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    round: integer("round").notNull().default(1),
    builderAgentId: uuid("builder_agent_id").references(() => agents.id),
    breakerAgentId: uuid("breaker_agent_id").references(() => agents.id),
    builderPosition: text("builder_position"),
    breakerPosition: text("breaker_position"),
    builderFamily: text("builder_family"),
    breakerFamily: text("breaker_family"),
    juryInvoked: boolean("jury_invoked").notNull().default(false),
    juryTriggeredAt: timestamp("jury_triggered_at", { withTimezone: true }),
    juryVerdict: text("jury_verdict"),
    juryDeliberatedAt: timestamp("jury_deliberated_at", { withTimezone: true }),
    reviewComplete: boolean("review_complete").notNull().default(false),
    reviewCompleteAt: timestamp("review_complete_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRepoPrIdx: index("pr_review_states_company_repo_pr_idx").on(
      table.companyId,
      table.repositoryFullName,
      table.prNumber,
    ),
    headShaIdx: index("pr_review_states_head_sha_idx").on(table.headSha),
    activeIdx: index("pr_review_states_active_idx").on(table.reviewComplete),
    juryIdx: index("pr_review_states_jury_idx").on(table.juryInvoked),
    uniqueRepoPrSha: uniqueIndex("pr_review_states_repo_pr_sha_unique").on(
      table.repositoryFullName,
      table.prNumber,
      table.headSha,
    ),
  }),
);

export type PrReviewState = typeof prReviewStates.$inferSelect;
export type NewPrReviewState = typeof prReviewStates.$inferInsert;

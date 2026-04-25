import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { prReviewStates } from "./pr_review_states.js";
import { agents } from "./agents.js";

export const reviewerFamilyLog = pgTable(
  "reviewer_family_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prReviewStateId: uuid("pr_review_state_id").notNull().references(() => prReviewStates.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id),
    reviewerFamily: text("reviewer_family").notNull(),
    reviewType: text("review_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stateRoundIdx: index("reviewer_family_log_state_round_idx").on(
      table.prReviewStateId,
      table.round,
    ),
  }),
);

export type ReviewerFamilyLog = typeof reviewerFamilyLog.$inferSelect;
export type NewReviewerFamilyLog = typeof reviewerFamilyLog.$inferInsert;

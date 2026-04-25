import { index, pgTable, text, timestamp, uuid, boolean, real } from "drizzle-orm/pg-core";
import { synthesizedSkills } from "./synthesized_skills.js";

export const skillEvalResults = pgTable(
  "skill_eval_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => synthesizedSkills.id, { onDelete: "cascade" }),
    evalRunId: text("eval_run_id").notNull(),
    score: real("score").notNull(),
    testTasks: text("test_tasks").notNull(),
    passed: boolean("passed").notNull().default(false),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewerAgentId: uuid("reviewer_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    skillIdIdx: index("skill_eval_results_skill_id_idx").on(table.skillId),
    evalRunIdIdx: index("skill_eval_results_eval_run_id_idx").on(table.evalRunId),
    passedIdx: index("skill_eval_results_passed_idx").on(table.passed),
    uniqueSkillEval: index("skill_eval_results_skill_id_eval_run_id_unique").on(table.skillId, table.evalRunId),
  }),
);

export type SkillEvalResult = typeof skillEvalResults.$inferSelect;
export type NewSkillEvalResult = typeof skillEvalResults.$inferInsert;
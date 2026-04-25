import { index, pgTable, text, timestamp, uuid, numeric } from "drizzle-orm/pg-core";
import { knowledgeTopics } from "./knowledge.js";

export const synthesizedSkills = pgTable(
  "synthesized_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => knowledgeTopics.id, { onDelete: "cascade" }),
    skillName: text("skill_name").notNull(),
    skillPath: text("skill_path").notNull(),
    status: text("status").notNull().default("pending_eval"),
    evalScore: numeric("eval_score", { precision: 3, scale: 2 }),
    evalTasks: text("eval_tasks"),
    synthesizedAt: timestamp("synthesized_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
  },
  (table) => ({
    topicIdIdx: index("synthesized_skills_topic_id_idx").on(table.topicId),
    statusIdx: index("synthesized_skills_status_idx").on(table.status),
    skillNameIdx: index("synthesized_skills_skill_name_idx").on(table.skillName),
  }),
);

export type SynthesizedSkill = typeof synthesizedSkills.$inferSelect;
export type NewSynthesizedSkill = typeof synthesizedSkills.$inferInsert;
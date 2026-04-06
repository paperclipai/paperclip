import {
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { goals } from "./goals.js";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";

export const goalCheckIns = pgTable(
  "goal_check_ins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: text("author_user_id").references(() => authUsers.id),
    progressPercent: numeric("progress_percent", { precision: 5, scale: 2 }),
    confidence: integer("confidence"),
    status: text("status").notNull().default("on_track"),
    note: text("note"),
    blockers: text("blockers"),
    nextSteps: text("next_steps"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    goalIdx: index("goal_check_ins_goal_idx").on(table.goalId),
    createdIdx: index("goal_check_ins_created_idx").on(table.createdAt),
  }),
);

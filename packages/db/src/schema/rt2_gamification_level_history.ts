import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Level history - tracks level ups/downs
 */
export const rt2GamificationLevelHistory = pgTable(
  "rt2_gamification_level_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    // Level before change
    levelBefore: integer("level_before").notNull(),
    // Level after change
    levelAfter: integer("level_after").notNull(),
    // XP at time of level change
    xpAtChange: integer("xp_at_change").notNull(),
    // Trigger: 'task_complete', 'approval', 'achievement', 'manual'
    trigger: text("trigger").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("level_history_company_agent_idx").on(table.companyId, table.agentId),
    companyCreatedIdx: index("level_history_company_created_idx").on(table.companyId, table.createdAt),
  }),
);

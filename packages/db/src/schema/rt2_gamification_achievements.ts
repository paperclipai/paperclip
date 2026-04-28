import { pgTable, uuid, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Achievement definitions and earned records
 */
export const rt2GamificationAchievements = pgTable(
  "rt2_gamification_achievements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    // Achievement key e.g., "first_task", "ten_streak", "level_10"
    achievementKey: text("achievement_key").notNull(),
    // Whether it requires agent-level or company-level achievement
    scope: text("scope").notNull().default("agent"), // "agent" | "company"
    // When earned (null if not yet earned)
    earnedAt: timestamp("earned_at", { withTimezone: true }),
    // Optional metadata
    metadataJson: text("metadata_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentKeyIdx: index("achievements_company_agent_key_idx").on(
      table.companyId,
      table.agentId,
      table.achievementKey,
    ),
    companyScopeIdx: index("achievements_company_scope_idx").on(table.companyId, table.scope),
  }),
);

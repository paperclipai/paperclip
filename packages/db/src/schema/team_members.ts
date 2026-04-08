import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { agents } from "./agents.js";

export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id),
    userId: text("user_id"),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamIdx: index("team_members_team_idx").on(table.teamId),
    teamAgentUniq: uniqueIndex("team_members_team_agent_uniq").on(table.teamId, table.agentId),
    agentIdx: index("team_members_agent_idx").on(table.agentId),
  }),
);

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export type AgentPresetEntry = {
  agentNameKey: string;
  agentName: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
};

export const agentPresets = pgTable(
  "agent_presets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    snapshot: jsonb("snapshot").$type<AgentPresetEntry[]>().notNull().default([]),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("agent_presets_company_idx").on(table.companyId),
    companyNameUnique: uniqueIndex("agent_presets_company_name_unique").on(
      table.companyId,
      table.name,
    ),
  }),
);

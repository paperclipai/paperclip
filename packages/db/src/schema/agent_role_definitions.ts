import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const agentRoleDefinitions = pgTable(
  "agent_role_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: text("role").notNull().unique(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    mountedPaths: text("mounted_paths").array().notNull().default([]),
    readOnlyPaths: text("read_only_paths").array().notNull().default([]),
    candidateModels: text("candidate_models").array().notNull().default([]),
    defaultSkills: text("default_skills").array().notNull().default([]),
    promptTemplateId: uuid("prompt_template_id"),
    modelFamily: text("model_family").notNull(),
    maxRounds: integer("max_rounds").notNull().default(3),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roleIdx: index("agent_role_definitions_role_idx").on(table.role),
    modelFamilyIdx: index("agent_role_definitions_model_family_idx").on(table.modelFamily),
    activeIdx: index("agent_role_definitions_active_idx").on(table.isActive),
  }),
);

export type AgentRoleDefinition = typeof agentRoleDefinitions.$inferSelect;
export type NewAgentRoleDefinition = typeof agentRoleDefinitions.$inferInsert;

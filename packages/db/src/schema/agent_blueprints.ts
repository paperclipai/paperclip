import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const agentBlueprints = pgTable(
  "agent_blueprints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    role: text("role").notNull().default("general"),
    title: text("title"),
    icon: text("icon"),
    capabilities: text("capabilities"),
    tags: text("tags").array().notNull().default([]),
    adapterType: text("adapter_type").notNull().default("process"),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    permissions: jsonb("permissions").$type<Record<string, unknown>>().notNull().default({}),
    instructionsContent: text("instructions_content"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    sourceAgentId: uuid("source_agent_id"),
    sourceBlueprintId: uuid("source_blueprint_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roleIdx: index("agent_blueprints_role_idx").on(table.role),
    nameIdx: index("agent_blueprints_name_idx").on(table.name),
  }),
);

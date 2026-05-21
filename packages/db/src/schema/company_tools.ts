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
import { agents } from "./agents.js";

export const companyTools = pgTable(
  "company_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    key: text("key").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    source: text("source").notNull(),
    adapter: text("adapter").notNull(),
    serverKey: text("server_key"),
    toolName: text("tool_name"),
    risk: text("risk").notNull().default("read"),
    supportedModes: jsonb("supported_modes").$type<string[]>().notNull().default(["off", "read"]),
    render: jsonb("render").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUniqueIdx: uniqueIndex("company_tools_company_key_idx").on(table.companyId, table.key),
    companySourceIdx: index("company_tools_company_source_idx").on(table.companyId, table.source),
  }),
);

export const agentToolGrants = pgTable(
  "agent_tool_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    toolId: uuid("tool_id").notNull().references(() => companyTools.id),
    mode: text("mode").notNull().default("off"),
    grantedByUserId: text("granted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentToolUniqueIdx: uniqueIndex("agent_tool_grants_agent_tool_idx").on(table.agentId, table.toolId),
    companyAgentIdx: index("agent_tool_grants_company_agent_idx").on(table.companyId, table.agentId),
  }),
);

import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  primaryKey,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import type { McpServerBindingMode } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { mcpServers } from "./mcp_servers.js";

export const agentMcpServers = pgTable(
  "agent_mcp_servers",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    mcpServerId: uuid("mcp_server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
    bindingMode: text("binding_mode").$type<McpServerBindingMode>().notNull().default("allowed"),
    enabled: boolean("enabled").notNull().default(true),
    allowedTools: jsonb("allowed_tools").$type<string[]>().notNull().default([]),
    bindingAuthority: text("binding_authority").notNull().default("board"),
    toolClearances: jsonb("tool_clearances").$type<Record<string, string>>().notNull().default({}),
    defaultMinUserRole: text("default_min_user_role").notNull().default("board"),
    autonomousAllowed: boolean("autonomous_allowed").notNull().default(false),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.agentId, table.mcpServerId],
      name: "agent_mcp_servers_pk",
    }),
    companyIdx: index("agent_mcp_servers_company_idx").on(table.companyId),
    agentIdx: index("agent_mcp_servers_agent_idx").on(table.agentId),
    mcpServerIdx: index("agent_mcp_servers_mcp_server_idx").on(table.mcpServerId),
    companyEnabledIdx: index("agent_mcp_servers_company_enabled_idx").on(table.companyId, table.enabled),
  }),
);

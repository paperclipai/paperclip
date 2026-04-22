import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import type {
  McpServerCatalogPrompt,
  McpServerCatalogResource,
  McpServerCatalogTool,
  McpServerDiscoveryStatus,
} from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { mcpServers } from "./mcp_servers.js";

export const mcpServerCatalogSnapshots = pgTable(
  "mcp_server_catalog_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    mcpServerId: uuid("mcp_server_id").notNull().references(() => mcpServers.id, {
      onDelete: "cascade",
    }),
    status: text("status").$type<McpServerDiscoveryStatus>().notNull().default("succeeded"),
    protocolVersion: text("protocol_version"),
    serverName: text("server_name"),
    serverVersion: text("server_version"),
    summary: text("summary"),
    tools: jsonb("tools").$type<McpServerCatalogTool[]>().notNull().default([]),
    resources: jsonb("resources").$type<McpServerCatalogResource[]>().notNull().default([]),
    prompts: jsonb("prompts").$type<McpServerCatalogPrompt[]>().notNull().default([]),
    serverInfo: jsonb("server_info").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("mcp_server_catalog_snapshots_company_idx").on(table.companyId),
    mcpServerIdx: index("mcp_server_catalog_snapshots_server_idx").on(table.mcpServerId),
    statusIdx: index("mcp_server_catalog_snapshots_status_idx").on(table.status),
    serverCreatedIdx: index("mcp_server_catalog_snapshots_server_created_idx").on(
      table.mcpServerId,
      table.createdAt,
    ),
  }),
);

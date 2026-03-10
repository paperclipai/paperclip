import { pgTable, uuid, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { mcpServers } from "./mcp_servers.js";

export const agentMcpServers = pgTable(
  "agent_mcp_servers",
  {
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    mcpServerId: uuid("mcp_server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.mcpServerId], name: "agent_mcp_servers_pk" }),
    agentIdx: index("agent_mcp_servers_agent_idx").on(table.agentId),
    mcpServerIdx: index("agent_mcp_servers_mcp_server_idx").on(table.mcpServerId),
    companyIdx: index("agent_mcp_servers_company_idx").on(table.companyId),
  }),
);

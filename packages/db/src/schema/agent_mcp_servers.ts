import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Per-agent installed MCP servers (issue #2).
 *
 * An agent requests an MCP server (raised as a `request_mcp_install` approval);
 * on board approval a row is written here and the server is delivered into that
 * agent's runtime as a `.mcp.json` entry. Partitioned by `agentId` so each agent
 * only ever loads the servers the board approved for it.
 *
 * Transports:
 * - `http`:  a remote MCP server. `config` is `{ url }`; `envBindings` are request
 *            headers (e.g. `{ "Authorization": <secret_ref> }`).
 * - `stdio`: a command the runtime launches (e.g. `npx -y <pkg>`). `config` is
 *            `{ command, args }`; `envBindings` are process env vars.
 *
 * Secret values never live here: `envBindings` carry `{type:"secret_ref",
 * secretId, version}` references resolved from `company_secrets` at run time.
 */
export const agentMcpServers = pgTable(
  "agent_mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    transport: text("transport").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    envBindings: jsonb("env_bindings").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("enabled"),
    // Provenance back to the approval that authorized the install (nullable).
    sourceApprovalId: uuid("source_approval_id"),
    createdByActorType: text("created_by_actor_type"),
    createdByActorId: text("created_by_actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => ({
    companyAgentStatusIdx: index("agent_mcp_servers_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    agentStatusIdx: index("agent_mcp_servers_agent_status_idx").on(table.agentId, table.status),
    // One server name per agent: makes reinstall an atomic upsert and blocks
    // concurrent approvals from inserting duplicates for the same agent/name.
    agentNameUniqueIdx: uniqueIndex("agent_mcp_servers_agent_name_unique").on(
      table.companyId,
      table.agentId,
      table.name,
    ),
  }),
);

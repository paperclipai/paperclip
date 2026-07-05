import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Company-level catalog of external MCP servers (mirrors company_skills).
 * Servers are defined once per company; agents opt in via the
 * `mcpServerRefs: string[]` key on their adapterConfig (names into this
 * catalog). `config` holds the canonical McpServerConfig with secret values
 * stored as company-secret references, never plaintext.
 */
export const companyMcpServers = pgTable(
  "company_mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    description: text("description"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameUniqueIdx: uniqueIndex("company_mcp_servers_company_name_idx").on(
      table.companyId,
      table.name,
    ),
  }),
);

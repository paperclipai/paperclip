import { pgTable, uuid, text, timestamp, index, uniqueIndex, boolean, jsonb } from "drizzle-orm/pg-core";
import type { AgentEnvConfig } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    transport: text("transport").notNull(),
    command: text("command"),
    args: jsonb("args").$type<string[]>().notNull().default([]),
    cwd: text("cwd"),
    url: text("url"),
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    env: jsonb("env").$type<AgentEnvConfig>().notNull().default({}),
    // Sealed credential material (localEncryptedProvider ref) — never plaintext.
    credentialSecretRef: text("credential_secret_ref"),
    enabled: boolean("enabled").notNull().default(false),
    governanceStatus: text("governance_status").notNull().default("pending"),
    riskLevel: text("risk_level").notNull().default("unknown"),
    riskFactors: jsonb("risk_factors").$type<string[]>().notNull().default([]),
    governanceUpdatedAt: timestamp("governance_updated_at", { withTimezone: true }),
    governanceUpdatedBy: text("governance_updated_by"),
    governanceReason: text("governance_reason"),
    lastHealthStatus: text("last_health_status").notNull().default("unknown"),
    lastHealthcheckAt: timestamp("last_healthcheck_at", { withTimezone: true }),
    lastDiscoveryAt: timestamp("last_discovery_at", { withTimezone: true }),
    lastError: text("last_error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("mcp_servers_company_idx").on(table.companyId),
    companyEnabledIdx: index("mcp_servers_company_enabled_idx").on(table.companyId, table.enabled),
    companyTransportIdx: index("mcp_servers_company_transport_idx").on(table.companyId, table.transport),
    companySlugUq: uniqueIndex("mcp_servers_company_slug_uq").on(table.companyId, table.slug),
  }),
);

import { pgTable, uuid, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { mcpServers } from "./mcp_servers.js";

export const mcpServerAuditLog = pgTable(
  "mcp_server_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    mcpServerId: uuid("mcp_server_id").references(() => mcpServers.id, { onDelete: "set null" }),
    serverSlug: text("server_slug").notNull(),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    riskLevel: text("risk_level"),
    toolName: text("tool_name"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    reason: text("reason"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    onBehalfOfUserId: text("on_behalf_of_user_id"),
    onBehalfOfRole: text("on_behalf_of_role"),
    decision: text("decision"),
    argsDigest: text("args_digest"),
    resultDigest: text("result_digest"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("mcp_server_audit_log_company_idx").on(table.companyId),
    serverIdx: index("mcp_server_audit_log_server_idx").on(table.mcpServerId),
    companyCreatedIdx: index("mcp_server_audit_log_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);

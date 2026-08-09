import { pgTable, uuid, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import type { AgentApiKeyScope } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentApiKeys = pgTable(
  "agent_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    responsibleUserId: text("responsible_user_id"),
    scopeConfig: jsonb("scope_config").$type<AgentApiKeyScope | null>(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Run id bound to this API key by the openclaw-gateway adapter at WS session
     * establishment (PHA-1845). When the agent omits the `X-Paperclip-Run-Id`
     * header on a mutating request, the server falls back to this value rather
     * than rejecting the call. The adapter clears this when the WS session
     * ends. Mismatch with an explicit header still returns 409.
     */
    sessionBoundRunId: uuid("session_bound_run_id"),
    sessionBoundAt: timestamp("session_bound_at", { withTimezone: true }),
  },
  (table) => ({
    keyHashIdx: index("agent_api_keys_key_hash_idx").on(table.keyHash),
    companyAgentIdx: index("agent_api_keys_company_agent_idx").on(table.companyId, table.agentId),
    sessionBoundRunIdIdx: index("agent_api_keys_session_bound_run_id_idx").on(table.sessionBoundRunId),
  }),
);

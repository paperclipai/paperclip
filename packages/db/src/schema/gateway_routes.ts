import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const gatewayRoutes = pgTable(
  "gateway_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    name: text("name").notNull(),
    priority: integer("priority").notNull().default(0),
    adapterType: text("adapter_type").notNull(),
    model: text("model").notNull(),
    weight: integer("weight").notNull().default(100),
    isEnabled: boolean("is_enabled").notNull().default(true),

    // Token quotas
    quotaTokensPerMinute: integer("quota_tokens_per_minute"),
    quotaTokensPerHour: integer("quota_tokens_per_hour"),
    quotaTokensPerDay: integer("quota_tokens_per_day"),

    // Request quotas
    quotaRequestsPerMinute: integer("quota_requests_per_minute"),
    quotaRequestsPerHour: integer("quota_requests_per_hour"),
    quotaRequestsPerDay: integer("quota_requests_per_day"),

    // Circuit breaker
    circuitBreakerEnabled: boolean("circuit_breaker_enabled").notNull().default(false),
    circuitBreakerFailureThreshold: integer("circuit_breaker_failure_threshold").notNull().default(3),
    circuitBreakerResetSec: integer("circuit_breaker_reset_sec").notNull().default(300),

    // Timeout override
    timeoutSec: integer("timeout_sec"),

    // Adapter configuration overrides (env vars, extra args, thinking effort, etc.)
    adapterConfigOverrides: jsonb("adapter_config_overrides"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("gateway_routes_company_agent_idx").on(table.companyId, table.agentId),
    companyEnabledIdx: index("gateway_routes_company_enabled_idx").on(
      table.companyId,
      table.isEnabled,
      table.priority,
    ),
  }),
);

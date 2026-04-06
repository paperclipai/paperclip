import { pgTable, uuid, text, boolean, integer, numeric, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const llmApiKeys = pgTable(
  "llm_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    provider: text("provider").notNull().default("anthropic"),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    modelFilter: text("model_filter"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    priority: integer("priority").notNull().default(0),
    monthlyBudgetUsd: numeric("monthly_budget_usd", { precision: 10, scale: 2 }),
    currentMonthSpendUsd: numeric("current_month_spend_usd", { precision: 10, scale: 2 }).notNull().default("0"),
    totalSpendUsd: numeric("total_spend_usd", { precision: 10, scale: 2 }).notNull().default("0"),
    totalRequests: integer("total_requests").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("llm_api_keys_company_idx").on(table.companyId),
    providerIdx: index("llm_api_keys_provider_idx").on(table.companyId, table.provider),
  }),
);

export const agentLlmKeyAssignments = pgTable(
  "agent_llm_key_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    llmApiKeyId: uuid("llm_api_key_id").notNull().references(() => llmApiKeys.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    assignedBy: text("assigned_by").notNull().default("manual"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdx: index("agent_llm_key_assignments_agent_idx").on(table.agentId),
    keyIdx: index("agent_llm_key_assignments_key_idx").on(table.llmApiKeyId),
    agentKeyUnique: uniqueIndex("agent_llm_key_assignments_agent_key_idx").on(table.agentId, table.llmApiKeyId),
  }),
);

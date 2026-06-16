import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { memoryBindings } from "./memory_bindings.js";

export const memoryOperations = pgTable(
  "memory_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id").references(() => memoryBindings.id, { onDelete: "set null" }),
    operation: text("operation").notNull(),
    hookKind: text("hook_kind"),
    intent: text("intent"),
    status: text("status").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    scopeJson: jsonb("scope_json").$type<Record<string, unknown>>(),
    requestJson: jsonb("request_json").$type<Record<string, unknown>>(),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    usageJson: jsonb("usage_json").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("memory_operations_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    companyRunIdx: index("memory_operations_company_run_idx").on(
      table.companyId,
      table.heartbeatRunId,
    ),
    companyAgentCreatedIdx: index("memory_operations_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
  }),
);

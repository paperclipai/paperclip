import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { memoryBindings } from "./memory_bindings.js";

/** Mirrors MemoryUsage from @paperclipai/plugins-sdk for JSONB column typing. */
interface MemoryUsageEntry {
  provider: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  embeddingTokens?: number;
  costCents?: number;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

/**
 * `memory_operations` table — audit log for all memory service operations.
 *
 * Records every write, query, forget, browse, and correct operation with
 * scope context (agent, project, issue, run) and performance metrics.
 */
export const memoryOperations = pgTable(
  "memory_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => memoryBindings.id, { onDelete: "cascade" }),
    /** Operation type: write, query, forget, browse, correct. */
    operationType: text("operation_type").notNull(),
    /** Agent that initiated the operation (nullable for system-initiated ops). */
    agentId: uuid("agent_id"),
    /** Project scope context. */
    projectId: uuid("project_id"),
    /** Issue scope context. */
    issueId: uuid("issue_id"),
    /** Heartbeat run scope context. */
    runId: uuid("run_id"),
    /** Provider-specific source reference (e.g. vector IDs, document keys). */
    sourceRef: jsonb("source_ref").$type<Record<string, unknown>>(),
    /** Usage metrics from the provider (tokens, embeddings, etc.). */
    usage: jsonb("usage").$type<MemoryUsageEntry[] | null>(),
    /** Round-trip latency in milliseconds. */
    latencyMs: integer("latency_ms"),
    /** Whether the operation completed successfully. */
    success: boolean("success").notNull().default(true),
    /** Error message if the operation failed. */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyBindingIdx: index("memory_operations_company_binding_idx").on(
      table.companyId,
      table.bindingId,
    ),
    companyAgentDateIdx: index("memory_operations_company_agent_date_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    companyDateIdx: index("memory_operations_company_date_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);

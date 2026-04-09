import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { memoryBindings } from "./memory_bindings.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * `memory_operations` — normalized audit log for every explicit memory
 * operation routed through the Paperclip memory control plane.
 *
 * Every write, query, forget, browse, and correct operation is recorded here
 * regardless of whether the provider is a built-in or a plugin.
 *
 * Phase 1: control-plane contract only — actual provider calls are wired in
 * Phase 2 when the first built-in provider ships.
 *
 * @see doc/plans/2026-03-17-memory-service-surface-api.md §Suggested Data Model
 */
export const memoryOperations = pgTable(
  "memory_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id").references(() => memoryBindings.id, { onDelete: "set null" }),

    // -- Operation type and scope ------------------------------------------------
    /**
     * Type of memory operation.
     * - `"write"` — store new memory content
     * - `"query"` — semantic or keyword search
     * - `"forget"` — delete memory records
     * - `"browse"` — paginated inspection of stored records
     * - `"correct"` — patch an existing memory record
     */
    operationType: text("operation_type").notNull(),

    // -- Scope: which Paperclip entities drove this operation --------------------
    /** Agent that initiated or is the target of this operation, if applicable. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** Issue this operation is associated with. */
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    /** Heartbeat run that triggered this operation. */
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    /** External / user subject identifier for user-scoped memory operations. */
    subjectId: text("subject_id"),

    // -- Source reference -------------------------------------------------------
    /**
     * Kind of Paperclip object that was the input source for a write operation.
     * e.g. `"issue_comment"`, `"run"`, `"manual_note"`, `"issue_document"`.
     */
    sourceKind: text("source_kind"),
    /** Serialized JSON bag of source reference fields (commentId, documentKey, etc.). */
    sourceRefJson: jsonb("source_ref_json"),

    // -- Request / response summary ---------------------------------------------
    /** First 4096 chars of the query string, for auditing and debugging. */
    queryExcerpt: text("query_excerpt"),
    /** Number of records returned (query/browse) or written (write). */
    resultCount: integer("result_count"),

    // -- Usage, cost, and performance ------------------------------------------
    /** Tokens consumed by the memory provider inference (input side). */
    inputTokens: integer("input_tokens"),
    /** Tokens consumed by the memory provider inference (output side). */
    outputTokens: integer("output_tokens"),
    /** Embedding tokens if the provider performed vector encoding. */
    embeddingTokens: integer("embedding_tokens"),
    /** Provider-billed cost in cents, if reported. */
    costCents: integer("cost_cents"),
    /** Wall-clock latency of the provider call in milliseconds. */
    latencyMs: integer("latency_ms"),

    // -- Outcome ---------------------------------------------------------------
    /** Whether the provider call succeeded. */
    success: boolean("success").notNull().default(true),
    /** Error message if the operation failed. */
    errorMessage: text("error_message"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOccurredIdx: index("memory_operations_company_occurred_idx").on(
      table.companyId,
      table.occurredAt,
    ),
    bindingOccurredIdx: index("memory_operations_binding_occurred_idx").on(
      table.bindingId,
      table.occurredAt,
    ),
    agentOccurredIdx: index("memory_operations_agent_occurred_idx").on(
      table.agentId,
      table.occurredAt,
    ),
    runIdx: index("memory_operations_run_idx").on(table.runId),
  }),
);

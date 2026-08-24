import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Memory bindings: named configurations that define how memory is stored
 * and queried for a company or agent. Each binding specifies a provider type
 * ("builtin_pgvector" or a plugin id) and provider-specific configuration.
 */
export const memoryBindings = pgTable(
  "memory_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    providerType: text("provider_type").notNull(),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    capabilitiesJson: jsonb("capabilities_json").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUnique: uniqueIndex("memory_bindings_company_key_idx").on(table.companyId, table.key),
    companyProviderIdx: index("memory_bindings_company_provider_idx").on(table.companyId, table.providerType),
  }),
);

/**
 * Memory binding targets: assigns a binding to a company or agent target.
 * Resolution order: find agent target → fall back to company default target.
 */
export const memoryBindingTargets = pgTable(
  "memory_binding_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    targetType: text("target_type").$type<"company" | "agent">().notNull(),
    targetId: uuid("target_id").notNull(),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => memoryBindings.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTargetUnique: uniqueIndex("memory_binding_targets_company_target_idx").on(
      table.companyId,
      table.targetType,
      table.targetId,
    ),
    bindingIdx: index("memory_binding_targets_binding_idx").on(table.bindingId),
  }),
);

/**
 * Memory records: the core memory data store. Embeddings live here alongside
 * structured metadata for semantic + full-text hybrid search.
 */
export const memoryRecords = pgTable(
  "memory_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => memoryBindings.id, { onDelete: "cascade" }),
    recordType: text("record_type").notNull(),
    text: text("text").notNull(),
    summary: text("summary"),
    embedding: vector("embedding", { dimensions: 1536 }),
    scopeCompanyId: uuid("scope_company_id"),
    scopeAgentId: uuid("scope_agent_id"),
    scopeProjectId: uuid("scope_project_id"),
    scopeIssueId: uuid("scope_issue_id"),
    scopeRunId: uuid("scope_run_id"),
    scopeSubjectId: text("scope_subject_id"),
    scopeSessionKey: text("scope_session_key"),
    scopeNamespace: text("scope_namespace"),
    sourceKind: text("source_kind").notNull(),
    sourceIssueId: uuid("source_issue_id"),
    sourceCommentId: uuid("source_comment_id"),
    sourceDocumentKey: text("source_document_key"),
    sourceRunId: uuid("source_run_id"),
    sourceActivityId: uuid("source_activity_id"),
    sourceExternalRef: text("source_external_ref"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
    importance: doublePrecision("importance"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => ({
    companyScopeRecordTypeIdx: index("memory_records_company_scope_idx").on(
      table.companyId,
      table.scopeAgentId,
      table.recordType,
    ),
    companySourceIdx: index("memory_records_source_idx").on(
      table.companyId,
      table.sourceKind,
      table.sourceIssueId,
    ),
    // B-tree index on (company_id, binding_id) for common memory query patterns
    companyBindingIdx: index("memory_records_company_binding_idx").on(
      table.companyId,
      table.bindingId,
    ),
    // B-tree index on (company_id, created_at) for time-range queries
    companyCreatedAtIdx: index("memory_records_created_at_idx").on(
      table.companyId,
      table.createdAt,
    ),
    // HNSW vector index on embedding for cosine similarity search (pgvector >= 0.5.0).
    // Required by memory-adapter.ts:545 which uses embedding <=> CAST(...) ORDER BY.
    // WITH (m=16, ef_construction=200) is set in the hand-crafted migration SQL.
    embeddingHnswIdx: index("memory_records_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  }),
);

/**
 * Memory operations: audit log for every memory action.
 */
export const memoryOperations = pgTable(
  "memory_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id")
      .references(() => memoryBindings.id, { onDelete: "cascade" }),
    providerKey: text("provider_key"),
    operationType: text("operation_type").notNull(),
    scopeJson: jsonb("scope_json").$type<Record<string, unknown>>().notNull().default({}),
    sourceRefJson: jsonb("source_ref_json").$type<Record<string, unknown>>().notNull().default({}),
    actorAgentId: uuid("actor_agent_id"),
    heartbeatRunId: uuid("heartbeat_run_id"),
    success: boolean("success").notNull(),
    errorMessage: text("error_message"),
    latencyMs: integer("latency_ms").notNull(),
    usageJson: jsonb("usage_json").$type<Record<string, unknown>>().notNull().default({}),
    recordCount: integer("record_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyBindingOperationIdx: index("memory_operations_company_binding_op_idx").on(
      table.companyId,
      table.bindingId,
      table.operationType,
    ),
    companyCreatedIdx: index("memory_operations_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);

/**
 * Memory extraction jobs: tracks async extraction operations for providers
 * that support provider-managed extraction.
 */
export const memoryExtractionJobs = pgTable(
  "memory_extraction_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => memoryBindings.id, { onDelete: "cascade" }),
    operationId: uuid("operation_id").references(() => memoryOperations.id, { onDelete: "set null" }),
    providerJobId: text("provider_job_id").notNull(),
    hookKind: text("hook_kind").notNull(),
    status: text("status").notNull().default("queued"),
    errorMessage: text("error_message"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    companyBindingStatusIdx: index("memory_extraction_jobs_company_binding_status_idx").on(
      table.companyId,
      table.bindingId,
      table.status,
    ),
    providerJobIdx: index("memory_extraction_jobs_provider_job_idx").on(table.providerJobId),
  }),
);
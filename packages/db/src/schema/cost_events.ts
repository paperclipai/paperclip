import { randomUUID } from "node:crypto";
import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id),
    goalId: uuid("goal_id").references(() => goals.id),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id),
    billingCode: text("billing_code"),
    provider: text("provider").notNull(),
    biller: text("biller").notNull().default("unknown"),
    billingType: text("billing_type").notNull().default("unknown"),
    costStatus: text("cost_status").notNull().default("reported"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // --- Token detail (JAC-4529/4530, migration 0221) ---
    reasoningTokens: integer("reasoning_tokens"),
    toolCallTokens: integer("tool_call_tokens"),
    currency: text("currency").notNull().default("USD"),
    pricingVersionRef: text("pricing_version_ref"),

    // --- Coverage-aware fail-closed fields (JAC-4529, migration 0221) ---
    coverageState: text("coverage_state").notNull().default("unknown"),
    sourceStatus: text("source_status").notNull().default("unavailable"),
    safeStatus: text("safe_status").notNull().default("unavailable"),
    confidence: text("confidence").notNull().default("low"),
    coverageWarning: text("coverage_warning"),

    // --- Privacy / retention (JAC-4533, migration 0221) ---
    visibilityClass: text("visibility_class").notNull().default("internal"),
    retentionClass: text("retention_class").notNull().default("standard"),
    redactionState: text("redaction_state").notNull().default("unredacted"),
    sourcePermissionRef: text("source_permission_ref"),
    tenantRefHash: text("tenant_ref_hash"),
    subjectRefHashes: text("subject_ref_hashes").array().notNull().default([]),
    sourceDeletedAt: timestamp("source_deleted_at", { withTimezone: true }),
    tombstoneRef: text("tombstone_ref"),
    policyVersion: text("policy_version"),

    // --- Event identity / idempotency (JAC-4532, migration 0221) ---
    sourceSystem: text("source_system").notNull().default("paperclip"),
    sourceEventId: text("source_event_id"),
    sourceEventVersion: text("source_event_version"),
    eventKind: text("event_kind").notNull().default("cost_report"),
    attemptIndex: integer("attempt_index").notNull().default(0),

    // --- Cost metadata (JAC-4530, migration 0224) ---
    priceBasis: text("price_basis").notNull().default("not_reported"),
    costConfidence: text("cost_confidence").notNull().default("low"),

    // JAC-4532 idempotency columns. The 0227 migration added these to the table
    // (ingest_id NOT NULL, default dropped) but the schema was never updated,
    // so Drizzle inserts omitted ingest_id and hit a NOT NULL violation. Dedup is
    // keyed on the source_event unique index, not ingest_id, so a generated
    // fallback here is safe; deterministic ingest_id computation is future work.
    observedSequence: integer("observed_sequence"),
    supersedesEventId: text("supersedes_event_id"),
    ingestId: text("ingest_id").notNull().$defaultFn(() => randomUUID()),
    payloadHash: text("payload_hash"),
  },
  (table) => ({
    companyOccurredIdx: index("cost_events_company_occurred_idx").on(table.companyId, table.occurredAt),
    companyAgentOccurredIdx: index("cost_events_company_agent_occurred_idx").on(
      table.companyId,
      table.agentId,
      table.occurredAt,
    ),
    companyProviderOccurredIdx: index("cost_events_company_provider_occurred_idx").on(
      table.companyId,
      table.provider,
      table.occurredAt,
    ),
    companyBillerOccurredIdx: index("cost_events_company_biller_occurred_idx").on(
      table.companyId,
      table.biller,
      table.occurredAt,
    ),
    companyHeartbeatRunIdx: index("cost_events_company_heartbeat_run_idx").on(
      table.companyId,
      table.heartbeatRunId,
    ),
    companyPrivacyIdx: index("cost_events_company_privacy_idx").on(
      table.companyId,
      table.visibilityClass,
      table.retentionClass,
      table.redactionState,
    ),
    // Idempotency enforcement (JAC-4532, migration 0227): re-ingest of the
    // same logical event is a no-op via ON CONFLICT DO NOTHING on this composite.
    sourceEventUq: uniqueIndex("cost_events_source_event_uq").on(
      table.companyId,
      table.sourceSystem,
      table.sourceEventId,
      table.eventKind,
      table.attemptIndex,
    ),
  }),
);

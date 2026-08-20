import { pgTable, uuid, text, timestamp, integer, index, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Normalized run event — emitted by the Paperclip adapter for EVERY
 * heartbeat_run, regardless of whether the run produced spend.
 *
 * This is distinct from cost_events (which represent spend line-items).
 * run_events capture coverage metadata so fail-closed reasoning works
 * even for zero-cost runs (process/http adapters, errors, sandbox failures).
 *
 * Token/cost fields are nullable: null means "not_reported", 0 means "explicitly zero".
 *
 * Event identity / idempotency (JAC-4532): sourceSystem, sourceEventId,
 * sourceEventVersion, eventKind, attemptIndex, observedSequence,
 * supersedesEventId, ingestId, payloadHash.
 *
 * Privacy / retention (JAC-4533): visibilityClass, retentionClass,
 * redactionState, sourcePermissionRef, tenantRefHash, subjectRefHashes,
 * sourceDeletedAt, tombstoneRef, policyVersion.
 *
 * Action-safety semantics (JAC-4534): routingStatus, quotaStatus,
 * publicationStatus, workStateConfidence, pauseEligibleScope,
 * operatorDecisionRequired.
 */
export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    issueId: uuid("issue_id").references(() => issues.id),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),

    // --- Core identity (JAC-4532 event identity and idempotency) ---
    /** Source system that emitted this event (paperclip, adapter, provider, external). */
    sourceSystem: text("source_system").notNull().default("paperclip"),
    /** Deterministic external event ID for idempotency — re-ingest is a no-op unless source version or hash changes. */
    sourceEventId: text("source_event_id"),
    /** Version of the source event schema/format. */
    sourceEventVersion: text("source_event_version"),
    /** Kind of event for idempotency keying (adapter_execution, cost_report, usage_report, lifecycle). */
    eventKind: text("event_kind").notNull().default("adapter_execution"),
    /** Retry/attempt index — incremented on re-ingest of the same logical event. */
    attemptIndex: integer("attempt_index").notNull().default(0),
    /** Monotonically increasing sequence number observed from the source. */
    observedSequence: integer("observed_sequence"),
    /** When this event supersedes a previous event ID (for corrections/replacements). */
    supersedesEventId: text("supersedes_event_id"),

    // --- Execution metadata ---
    adapterType: text("adapter_type").notNull(),
    model: text("model").notNull().default("unknown"),
    provider: text("provider").notNull().default("unknown"),
    status: text("status").notNull().default("success"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    toolCallTokens: integer("tool_call_tokens"),
    costCents: integer("cost_cents"),
    currency: text("currency").notNull().default("USD"),

    // --- Usage reporting state ---
    usageReportedState: text("usage_reported_state").notNull().default("not_reported"),
    usageSourceField: text("usage_source_field"),

    // --- Coverage-aware fail-closed fields (JAC-4530) ---
    coverageState: text("coverage_state").notNull().default("unknown"),
    sourceStatus: text("source_status").notNull().default("unavailable"),
    safeStatus: text("safe_status").notNull().default("unavailable"),
    confidence: text("confidence").notNull().default("low"),

    // --- Cost metadata (JAC-4530) ---
    priceBasis: text("price_basis").notNull().default("not_reported"),
    costConfidence: text("cost_confidence").notNull().default("low"),
    pricingVersionRef: text("pricing_version_ref"),
    nativeTotalTokens: integer("native_total_tokens"),
    recomputedTotalTokens: integer("recomputed_total_tokens"),
    isSubscriptionIncluded: boolean("is_subscription_included").notNull().default(false),

    // --- Privacy / retention (JAC-4533) ---
    visibilityClass: text("visibility_class").notNull().default("internal"),
    retentionClass: text("retention_class").notNull().default("standard"),
    redactionState: text("redaction_state").notNull().default("unredacted"),
    sourcePermissionRef: text("source_permission_ref"),
    tenantRefHash: text("tenant_ref_hash"),
    /** JSONB array of subject reference hashes (SHA-256) for multi-subject attribution. */
    subjectRefHashes: text("subject_ref_hashes").array(),
    sourceDeletedAt: timestamp("source_deleted_at", { withTimezone: true }),
    tombstoneRef: text("tombstone_ref"),
    policyVersion: text("policy_version"),

    // --- Action-safety semantics (JAC-4534) ---
    /** Whether the agent/route is safe to dispatch work to. Fail-closed: unknown = unroutable. */
    routingStatus: text("routing_status").notNull().default("unknown"),
    /** Provider quota availability. Fail-closed: unknown = treat as unavailable. */
    quotaStatus: text("quota_status").notNull().default("unknown"),
    /** Whether cost/usage publication is safe for downstream consumers. Fail-closed: unknown = blocked. */
    publicationStatus: text("publication_status").notNull().default("unknown"),
    /** Confidence in the current work-state assessment. */
    workStateConfidence: text("work_state_confidence").notNull().default("unknown"),
    /** Scope of pause eligibility for this event. */
    pauseEligibleScope: text("pause_eligible_scope").notNull().default("none"),
    /** Whether explicit operator approval is required for the current state. */
    operatorDecisionRequired: boolean("operator_decision_required").notNull().default(false),

    // --- Ingestion tracking ---
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Deterministic ingest ID — computed from run_id + usage_updated_at + payload_hash (JAC-4532). */
    ingestId: text("ingest_id").notNull(),
    payloadHash: text("payload_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runEventsCompanyRunIdx: index("run_events_company_run_idx").on(
      table.companyId,
      table.runId,
    ),
    runEventsCompanyCoverageIdx: index("run_events_company_coverage_idx").on(
      table.companyId,
      table.coverageState,
      table.observedAt,
    ),
    runEventsCompanySafeStatusIdx: index("run_events_company_safe_status_idx").on(
      table.companyId,
      table.safeStatus,
      table.observedAt,
    ),
    runEventsPayloadHashIdx: index("run_events_payload_hash_idx").on(
      table.companyId,
      table.payloadHash,
    ),
    /** Idempotency enforcement (JAC-4532): re-ingest of the same logical event
     * is a no-op via ON CONFLICT DO NOTHING on this composite. */
    runEventsSourceEventUq: uniqueIndex("run_events_source_event_uq").on(
      table.companyId,
      table.sourceSystem,
      table.sourceEventId,
      table.eventKind,
      table.attemptIndex,
    ),
    runEventsRoutingIdx: index("run_events_routing_idx").on(
      table.companyId,
      table.routingStatus,
      table.observedAt,
    ),
    runEventsActionSafetyIdx: index("run_events_action_safety_idx").on(
      table.companyId,
      table.routingStatus,
      table.quotaStatus,
      table.publicationStatus,
    ),
    runEventsPrivacyIdx: index("run_events_privacy_idx").on(
      table.companyId,
      table.visibilityClass,
      table.retentionClass,
      table.redactionState,
    ),
  }),
);

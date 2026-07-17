import { sql } from "drizzle-orm";
import { check, type AnyPgColumn, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { issueWorkProducts } from "./issue_work_products.js";

export const deliveryEvents = pgTable(
  "delivery_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    state: text("state").notNull(),
    candidateSha: text("candidate_sha"),
    environment: text("environment"),
    provider: text("provider"),
    providerExternalId: text("provider_external_id"),
    providerUrl: text("provider_url"),
    sourceKind: text("source_kind").notNull(),
    authority: text("authority").notNull(),
    summary: text("summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    sourceFingerprint: text("source_fingerprint"),
    sourceWorkProductId: uuid("source_work_product_id").references(() => issueWorkProducts.id, { onDelete: "set null" }),
    supersedesEventId: uuid("supersedes_event_id").references((): AnyPgColumn => deliveryEvents.id, { onDelete: "set null" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stageCheck: check(
      "delivery_events_stage_check",
      sql`${table.stage} in ('implementation', 'ci', 'deployment', 'smoke', 'functional_qa', 'technical_acceptance', 'business_acceptance')`,
    ),
    stateCheck: check(
      "delivery_events_state_check",
      sql`${table.state} in ('unknown', 'pending', 'succeeded', 'failed', 'rolled_back', 'accepted', 'rejected', 'skipped')`,
    ),
    sourceKindCheck: check(
      "delivery_events_source_kind_check",
      sql`${table.sourceKind} in ('provider_observation', 'paperclip_action', 'user_submission', 'agent_submission', 'legacy_backfill')`,
    ),
    authorityCheck: check(
      "delivery_events_authority_check",
      sql`${table.authority} in ('provider_verified', 'paperclip_verified', 'user_asserted', 'agent_claim', 'legacy_unverified')`,
    ),
    issueCreatedIdx: index("delivery_events_company_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
      table.id,
    ),
    issueStageObservedIdx: index("delivery_events_company_issue_stage_observed_idx").on(
      table.companyId,
      table.issueId,
      table.stage,
      table.observedAt,
    ),
    providerExternalIdx: index("delivery_events_company_provider_external_idx").on(
      table.companyId,
      table.provider,
      table.providerExternalId,
    ),
    legacyWorkProductUq: uniqueIndex("delivery_events_legacy_work_product_uq").on(
      table.companyId,
      table.issueId,
      table.sourceWorkProductId,
    ),
    sourceFingerprintUq: uniqueIndex("delivery_events_source_fingerprint_uq").on(
      table.companyId,
      table.issueId,
      table.sourceFingerprint,
    ),
    supersedesOnceUq: uniqueIndex("delivery_events_supersedes_once_uq")
      .on(table.companyId, table.issueId, table.supersedesEventId)
      .where(sql`${table.supersedesEventId} is not null`),
    sourceAuthorityPairCheck: check(
      "delivery_events_source_authority_pair_check",
      sql`(
        (${table.sourceKind} = 'provider_observation' AND ${table.authority} = 'provider_verified') OR
        (${table.sourceKind} = 'paperclip_action' AND ${table.authority} = 'paperclip_verified') OR
        (${table.sourceKind} = 'user_submission' AND ${table.authority} = 'user_asserted') OR
        (${table.sourceKind} = 'agent_submission' AND ${table.authority} = 'agent_claim') OR
        (${table.sourceKind} = 'legacy_backfill' AND ${table.authority} = 'legacy_unverified')
      )`,
    ),
  }),
);

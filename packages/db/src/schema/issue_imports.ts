import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueComments } from "./issue_comments.js";

export const issueImportRuns = pgTable(
  "issue_import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    manifestVersion: integer("manifest_version").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    sourceSnapshotVersion: text("source_snapshot_version").notNull(),
    sourceSnapshotRetrievedAt: timestamp("source_snapshot_retrieved_at", { withTimezone: true }).notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    actorRunId: uuid("actor_run_id"),
    status: text("status").notNull().default("preview_ready"),
    receivedCount: integer("received_count").notNull().default(0),
    createdCount: integer("created_count").notNull().default(0),
    linkedCount: integer("linked_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    unchangedCount: integer("unchanged_count").notNull().default(0),
    conflictCount: integer("conflict_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    relationCount: integer("relation_count").notNull().default(0),
    commentCreatedCount: integer("comment_created_count").notNull().default(0),
    commentDeduplicatedCount: integer("comment_deduplicated_count").notNull().default(0),
    assignmentCount: integer("assignment_count").notNull().default(0),
    wakeCount: integer("wake_count").notNull().default(0),
    errorSummary: text("error_summary"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("issue_import_runs_company_created_idx").on(table.companyId, table.createdAt),
    companyDigestIdx: index("issue_import_runs_company_digest_idx").on(table.companyId, table.manifestDigest),
  }),
);

export const issueImportItems = pgTable(
  "issue_import_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => issueImportRuns.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    itemIndex: integer("item_index").notNull(),
    sourceId: text("source_id").notNull(),
    sourceIdentifier: text("source_identifier").notNull(),
    sourceVersion: text("source_version").notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
    sourceUrl: text("source_url").notNull(),
    action: text("action").notNull(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    sourceData: jsonb("source_data").$type<Record<string, unknown>>().notNull(),
    proposed: jsonb("proposed").$type<Record<string, unknown>>().notNull(),
    current: jsonb("current").$type<Record<string, unknown> | null>(),
    applied: jsonb("applied").$type<Record<string, unknown> | null>(),
    conflicts: jsonb("conflicts").$type<string[]>().notNull(),
    failures: jsonb("failures").$type<string[]>().notNull(),
    relationResults: jsonb("relation_results").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSourceUnique: uniqueIndex("issue_import_items_run_source_uq").on(table.runId, table.sourceId),
    companySourceIdx: index("issue_import_items_company_source_idx").on(table.companyId, table.provider, table.sourceId),
  }),
);

export const issueOriginStates = pgTable(
  "issue_origin_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    sourceId: text("source_id").notNull(),
    sourceIdentifier: text("source_identifier").notNull(),
    sourceVersion: text("source_version").notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
    sourceUrl: text("source_url").notNull(),
    lastReconciledRunId: uuid("last_reconciled_run_id").notNull().references(() => issueImportRuns.id),
    state: text("state").notNull().default("staged"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProviderSourceUnique: uniqueIndex("issue_origin_states_company_provider_source_uq").on(
      table.companyId,
      table.provider,
      table.sourceId,
    ),
    issueProviderUnique: uniqueIndex("issue_origin_states_issue_provider_uq").on(table.issueId, table.provider),
  }),
);

export const providerEventReceipts = pgTable(
  "provider_event_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    sourceCommentId: text("source_comment_id").notNull(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    issueCommentId: uuid("issue_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    importRunId: uuid("import_run_id").notNull().references(() => issueImportRuns.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProviderEventUnique: uniqueIndex("provider_event_receipts_company_provider_event_uq").on(
      table.companyId,
      table.provider,
      table.sourceEventId,
      table.sourceCommentId,
    ),
    issueIdx: index("provider_event_receipts_issue_idx").on(table.issueId),
  }),
);

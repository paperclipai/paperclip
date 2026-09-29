import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/** Current authority only; settled receipts and history never accumulate here. */
export const nativeSessionAuthorities = pgTable("native_session_authorities", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull(),
  normalizedSessionId: text("normalized_session_id").notNull(),
  runId: uuid("run_id").notNull(),
  successorRunId: uuid("successor_run_id"),
  binding: text("binding").notNull(),
  generation: text("generation").notNull(),
  committedFrom: text("committed_from"),
  state: text("state").notNull(),
  stateSha256: text("state_sha256").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.companyId, table.normalizedSessionId, table.runId] }),
  ownerUq: unique("native_session_authorities_owner_uq").on(table.companyId, table.issueId, table.normalizedSessionId, table.runId),
  issueOwnerFk: foreignKey({ columns: [table.companyId, table.issueId], foreignColumns: [issues.companyId, issues.id], name: "native_session_authorities_issue_owner_fk" }).onDelete("cascade"),
  runOwnerFk: foreignKey({ columns: [table.companyId, table.issueId, table.runId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.nativeIssueId, heartbeatRuns.id], name: "native_session_authorities_run_owner_fk" }).onDelete("cascade"),
  stateBound: check("native_session_authorities_state_bound", sql`octet_length(${table.state}) <= 16777216`),
  generationPositive: check("native_session_authorities_generation_positive", sql`${table.generation} ~ '^(r:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|[1-9][0-9]{0,18})$'`),
  predecessorValid: check("native_session_authorities_predecessor_valid", sql`(${table.generation} NOT LIKE 'r:%' OR ${table.committedFrom} IS NOT NULL) AND (${table.committedFrom} IS NULL OR (${table.committedFrom} <> ${table.generation} AND ${table.committedFrom} ~ '^(r:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|0|[1-9][0-9]{0,18})$'))`),
}));

/** Immutable replay receipts, keyed by authenticated epoch. Pagination and
 * ancient replay use indexes; neither path reconstructs the current snapshot. */
export const nativeAuthorityRecords = pgTable("native_authority_records", {
  companyId: uuid("company_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  normalizedSessionId: text("normalized_session_id").notNull(),
  runId: uuid("run_id").notNull(),
  kind: text("kind").notNull(),
  recordId: text("record_id").notNull(),
  sequence: bigint("sequence", { mode: "bigint" }).notNull(),
  sequenceEpoch: text("sequence_epoch").notNull().default(""),
  body: text("body").notNull(),
  bodySha256: text("body_sha256").notNull(),
  bodyEncoding: text("body_encoding").notNull().default("json"),
  bodyBytes: bigint("body_bytes", { mode: "number" }),
}, (table) => ({
  pk: primaryKey({ columns: [table.companyId, table.normalizedSessionId, table.runId, table.kind, table.recordId] }),
  sessionEffectUq: uniqueIndex("native_authority_records_session_effect_uq").on(table.companyId, table.normalizedSessionId, table.recordId).where(sql`${table.kind} = 'effect'`),
  sequenceUq: uniqueIndex("native_authority_records_sequence_uq").on(table.companyId, table.normalizedSessionId, table.runId, table.kind, table.sequenceEpoch, table.sequence).where(sql`${table.kind} <> 'effect'`),
  authorityOwnerFk: foreignKey({ columns: [table.companyId, table.issueId, table.normalizedSessionId, table.runId], foreignColumns: [nativeSessionAuthorities.companyId, nativeSessionAuthorities.issueId, nativeSessionAuthorities.normalizedSessionId, nativeSessionAuthorities.runId], name: "native_authority_records_authority_owner_fk" }).onDelete("cascade"),
  runOwnerFk: foreignKey({ columns: [table.companyId, table.issueId, table.runId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.nativeIssueId, heartbeatRuns.id], name: "native_authority_records_run_owner_fk" }).onDelete("cascade"),
  bodyBound: check("native_authority_records_body_bound", sql`octet_length(${table.body}) <= 1048576`),
  bodyEncodingValid: check("native_authority_records_body_encoding_valid", sql`(${table.bodyEncoding} = 'json' AND ${table.bodyBytes} IS NULL) OR (${table.bodyEncoding} = 'object.v1' AND ${table.bodyBytes} IS NOT NULL AND ${table.bodyBytes} BETWEEN 1 AND 1048576)`),
  kindValid: check("native_authority_records_kind_valid", sql`${table.kind} in ('command', 'event', 'effect')`),
  sequenceEpochValid: check("native_authority_records_sequence_epoch_valid", sql`${table.sequenceEpoch} = '' OR (${table.kind} IN ('command', 'event') AND ${table.sequenceEpoch} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')`),
  sequencePositive: check("native_authority_records_sequence_positive", sql`${table.sequence} > 0 OR (${table.kind} = 'effect' AND ${table.sequence} = 0)`),
}));

/** Unresolved owners are paged current work, not a growing checkpoint array.
 * The originating run stays attached when a later epoch retires the owner. */
export const nativeAuthorityWork = pgTable("native_authority_work", {
  companyId: uuid("company_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  normalizedSessionId: text("normalized_session_id").notNull(),
  runId: uuid("run_id").notNull(),
  collection: text("collection").notNull(),
  workId: text("work_id").notNull(),
  body: text("body").notNull(),
  bodySha256: text("body_sha256").notNull(),
}, table => ({
  pk: primaryKey({ columns: [table.companyId, table.normalizedSessionId, table.collection, table.workId] }),
  authorityOwnerFk: foreignKey({ columns: [table.companyId, table.issueId, table.normalizedSessionId, table.runId], foreignColumns: [nativeSessionAuthorities.companyId, nativeSessionAuthorities.issueId, nativeSessionAuthorities.normalizedSessionId, nativeSessionAuthorities.runId], name: "native_authority_work_authority_owner_fk" }).onDelete("cascade"),
  bodyBound: check("native_authority_work_body_bound", sql`octet_length(${table.body}) <= 16384`),
  collectionValid: check("native_authority_work_collection_valid", sql`${table.collection} = 'process-owner'`),
}));

/** Cumulative source cursor, maintained with event insertion; independent of history size. */
export const nativeSourceCursors = pgTable("native_source_cursors", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull(),
  sourceInstanceId: text("source_instance_id").notNull(),
  sourceEpoch: text("source_epoch").notNull().default(""),
  cursor: bigint("cursor", { mode: "number" }).notNull().default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.runId, table.sourceInstanceId] }),
  runOwnerFk: foreignKey({ columns: [table.companyId, table.runId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id], name: "native_source_cursors_run_owner_fk" }).onDelete("cascade"),
  cursorPositive: check("native_source_cursors_cursor_positive", sql`${table.cursor} >= 0`),
}));

/** One immutable close receipt per normalized source namespace. The current
 * head stays in native_source_cursors; opening it never scans these receipts. */
export const nativeSourceEpochs = pgTable("native_source_epochs", {
  companyId: uuid("company_id").notNull(),
  runId: uuid("run_id").notNull(),
  sourceInstanceId: text("source_instance_id").notNull(),
  fromEpoch: text("from_epoch").notNull(),
  nextEpoch: uuid("next_epoch").notNull(),
  transitionId: uuid("transition_id").notNull(),
  finalOrdinal: bigint("final_ordinal", { mode: "number" }).notNull(),
  transition: jsonb("transition").$type<Record<string, unknown>>().notNull(),
}, table => ({
  pk: primaryKey({ columns: [table.runId, table.sourceInstanceId, table.fromEpoch] }),
  successorUq: uniqueIndex("native_source_epochs_successor_uq").on(table.runId, table.sourceInstanceId, table.nextEpoch),
  transitionUq: uniqueIndex("native_source_epochs_transition_uq").on(table.runId, table.sourceInstanceId, table.transitionId),
  runOwnerFk: foreignKey({ columns: [table.companyId, table.runId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id], name: "native_source_epochs_run_owner_fk" }).onDelete("cascade"),
  ordinalBound: check("native_source_epochs_ordinal_bound", sql`${table.finalOrdinal} > 0 and ${table.finalOrdinal} <= 9007199254740991`),
}));

import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { activityLog } from "./activity_log.js";

/**
 * Dedicated machine credentials for the work projection. These hashes never
 * live in agent_api_keys, so a binary that predates this capability cannot
 * reinterpret a restrictive credential as a standard agent key.
 */
export const companyWorkProjectionCredentials = pgTable(
  "company_work_projection_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    tokenVersion: integer("token_version").notNull().default(1),
    creationActivityId: uuid("creation_activity_id")
      .notNull()
      .references(() => activityLog.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationActivityId: uuid("revocation_activity_id")
      .references(() => activityLog.id),
  },
  (table) => ({
    keyHashUniqueIdx: uniqueIndex("company_work_projection_credentials_key_hash_idx")
      .on(table.keyHash),
    companyCreatedIdx: index("company_work_projection_credentials_company_created_idx")
      .on(table.companyId, table.createdAt),
  }),
);

export const companyWorkProjectionRevisions = pgTable("company_work_projection_revisions", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  currentRevision: bigint("current_revision", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  currentIntegrityToken: uuid("current_integrity_token").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Independent source-integrity witness. Operational projection-table restores
 * exclude this table, so restoring the counter/history to an older prefix is
 * detected before any response is served.
 */
export const companyWorkProjectionSourceWitnesses = pgTable(
  "company_work_projection_source_witnesses",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    currentRevision: bigint("current_revision", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    currentIntegrityToken: uuid("current_integrity_token").notNull(),
    databaseEpoch: uuid("database_epoch").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Offline recovery verification receipt. Normal captured source writes may
 * extend a current receipt transactionally; maintenance must invalidate and
 * fully re-verify continuity before reads can resume.
 */
export const companyWorkProjectionVerifications = pgTable(
  "company_work_projection_verifications",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    databaseEpoch: uuid("database_epoch").notNull(),
    verifiedRevision: bigint("verified_revision", { mode: "bigint" }).notNull(),
    verifiedIntegrityToken: uuid("verified_integrity_token").notNull(),
    verifiedHistoryCount: bigint("verified_history_count", { mode: "bigint" }).notNull(),
    verifiedEventCount: bigint("verified_event_count", { mode: "bigint" }).notNull(),
    verifiedHeadCount: bigint("verified_head_count", { mode: "bigint" }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Append-only safe-field history used to materialize immutable company work
 * snapshots. Deliberately omits title, description, execution/recovery state,
 * adapter configuration, workspace paths, credentials, and private payloads.
 */
export const issueWorkProjectionVersions = pgTable(
  "issue_work_projection_versions",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    deleted: boolean("deleted").notNull().default(false),
    identifier: text("identifier"),
    projectId: uuid("project_id"),
    assigneeAgentId: uuid("assignee_agent_id"),
    assigneeUserId: text("assignee_user_id"),
    projectReferenceValid: boolean("project_reference_valid").notNull().default(true),
    assigneeAgentReferenceValid: boolean("assignee_agent_reference_valid").notNull().default(true),
    assigneeUserReferenceValid: boolean("assignee_user_reference_valid").notNull().default(true),
    status: text("status"),
    priority: text("priority"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    integrityToken: uuid("integrity_token").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.revision] }),
    companyIssueRevisionIdx: index("issue_work_projection_versions_company_issue_revision_idx")
      .on(table.companyId, table.issueId, table.revision),
    companyRevisionTokenUniqueIdx: uniqueIndex(
      "issue_work_projection_versions_company_revision_token_idx",
    ).on(table.companyId, table.revision, table.integrityToken),
  }),
);

/**
 * One bounded routing row per issue/company lifetime. Historical pages walk
 * this table by first revision and issue id and perform one indexed history
 * lookup per head; accumulated issue revisions are never reconstructed for
 * each request.
 */
export const companyWorkProjectionIssueHeads = pgTable(
  "company_work_projection_issue_heads",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull(),
    firstRevision: bigint("first_revision", { mode: "bigint" }).notNull(),
    currentRevision: bigint("current_revision", { mode: "bigint" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.issueId] }),
    currentRevisionFk: foreignKey({
      columns: [table.companyId, table.currentRevision],
      foreignColumns: [issueWorkProjectionVersions.companyId, issueWorkProjectionVersions.revision],
      name: "company_work_projection_issue_heads_current_fk",
    }),
    companyFirstRevisionIdx: index("company_work_projection_issue_heads_first_revision_idx")
      .on(table.companyId, table.firstRevision, table.issueId),
  }),
);

export const companyWorkProjectionSourceEvents = pgTable(
  "company_work_projection_source_events",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    integrityToken: uuid("integrity_token").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.revision] }),
    historyFk: foreignKey({
      columns: [table.companyId, table.revision, table.integrityToken],
      foreignColumns: [
        issueWorkProjectionVersions.companyId,
        issueWorkProjectionVersions.revision,
        issueWorkProjectionVersions.integrityToken,
      ],
      name: "company_work_projection_source_events_history_fk",
    }),
  }),
);

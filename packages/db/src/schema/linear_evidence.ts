import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const linearEvidenceMappings = pgTable(
  "linear_evidence_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    paperclipIssueId: uuid("paperclip_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    mappingKey: text("mapping_key").notNull(),
    linearIssueId: text("linear_issue_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueUq: uniqueIndex("linear_evidence_mappings_issue_uq").on(table.paperclipIssueId),
    mappingKeyUq: uniqueIndex("linear_evidence_mappings_key_uq").on(table.mappingKey),
    companyIdx: index("linear_evidence_mappings_company_idx").on(table.companyId),
  }),
);

export const linearEvidenceDeliveries = pgTable(
  "linear_evidence_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mappingId: uuid("mapping_id").notNull().references(() => linearEvidenceMappings.id, { onDelete: "cascade" }),
    paperclipIssueUpdatedAt: timestamp("paperclip_issue_updated_at", { withTimezone: true }).notNull(),
    evidenceSha256: text("evidence_sha256").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    evidenceJson: jsonb("evidence_json").$type<Record<string, unknown>>().notNull(),
    commentBodySha256: text("comment_body_sha256").notNull(),
    state: text("state").$type<"pending" | "published" | "conflict">().notNull().default("pending"),
    remoteCommentId: text("remote_comment_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stateCheck: check(
      "linear_evidence_deliveries_state_check",
      sql`${table.state} in ('pending', 'published', 'conflict')`,
    ),
    idempotencyUq: uniqueIndex("linear_evidence_deliveries_idempotency_uq").on(table.idempotencyKey),
    mappingVersionIdx: index("linear_evidence_deliveries_mapping_version_idx").on(
      table.mappingId,
      table.paperclipIssueUpdatedAt,
      table.createdAt,
    ),
    leaseIdx: index("linear_evidence_deliveries_lease_idx").on(table.state, table.leaseExpiresAt),
  }),
);

export const linearEvidenceConflicts = pgTable(
  "linear_evidence_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mappingId: uuid("mapping_id").notNull().references(() => linearEvidenceMappings.id, { onDelete: "cascade" }),
    conflictKey: text("conflict_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    paperclipValue: jsonb("paperclip_value").notNull(),
    linearValue: jsonb("linear_value").notNull(),
    resolution: text("resolution").$type<"unresolved" | "resolved">().notNull().default("unresolved"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedByAgentId: uuid("resolved_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  },
  (table) => ({
    resolutionCheck: check(
      "linear_evidence_conflicts_resolution_check",
      sql`${table.resolution} in ('unresolved', 'resolved')`,
    ),
    fingerprintUq: uniqueIndex("linear_evidence_conflicts_fingerprint_uq").on(table.mappingId, table.fingerprint),
    unresolvedIdx: index("linear_evidence_conflicts_unresolved_idx").on(
      table.mappingId,
      table.resolution,
      table.detectedAt,
    ),
  }),
);

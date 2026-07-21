import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueAttachments } from "./issue_attachments.js";

export const issueImageGenerationJobs = pgTable(
  "issue_image_generation_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    request: jsonb("request").notNull(),
    referenceSnapshot: jsonb("reference_snapshot").notNull(),
    actor: jsonb("actor").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    lastError: text("last_error"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outputAttachmentId: uuid("output_attachment_id").references(() => issueAttachments.id, { onDelete: "set null" }),
    auditAttachmentId: uuid("audit_attachment_id").references(() => issueAttachments.id, { onDelete: "set null" }),
    terminalAudit: jsonb("terminal_audit"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("issue_image_generation_jobs_issue_idx").on(table.companyId, table.issueId, table.createdAt),
    statusIdx: index("issue_image_generation_jobs_status_idx").on(table.status, table.createdAt),
    leaseIdx: index("issue_image_generation_jobs_lease_idx").on(table.status, table.leaseExpiresAt),
    issueIdempotencyUq: uniqueIndex("issue_image_generation_jobs_issue_idempotency_uq").on(
      table.issueId,
      table.idempotencyKey,
    ),
  }),
);

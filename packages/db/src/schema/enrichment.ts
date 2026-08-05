import { index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Company-owned queue rows for the local enrichment dispatcher. */
export const enrichmentQueue = pgTable(
  "enrichment_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceRowId: text("source_row_id").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusCreatedIdx: index("enrichment_queue_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    companySourceRowIdx: index("enrichment_queue_company_source_row_idx").on(table.companyId, table.sourceRowId),
  }),
);

/** AI output retained for a company until an authorized human review decision. */
export const enrichmentStaging = pgTable(
  "enrichment_staging",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").notNull(),
    sourceRowId: text("source_row_id").notNull(),
    primaryOutputJson: jsonb("primary_output_json").$type<Record<string, unknown>>(),
    fallbackOutputJson: jsonb("fallback_output_json").$type<Record<string, unknown>>(),
    validatorResult: jsonb("validator_result").$type<Record<string, unknown>>(),
    anomalyScore: numeric("anomaly_score", { precision: 5, scale: 4 }),
    reviewerVerdict: text("reviewer_verdict"),
    humanApprovedAt: timestamp("human_approved_at", { withTimezone: true }),
    humanApprovedBy: text("human_approved_by"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyBatchIdx: index("enrichment_staging_company_batch_idx").on(table.companyId, table.batchId),
    companyReviewIdx: index("enrichment_staging_company_review_idx").on(table.companyId, table.humanApprovedAt),
  }),
);

/** Append-only record for explicit promotion operations. */
export const enrichmentPromotionLog = pgTable(
  "enrichment_promotion_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").notNull(),
    rowCount: integer("row_count").notNull(),
    approverAgentId: text("approver_agent_id"),
    approverUserId: text("approver_user_id"),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull(),
    promotedAt: timestamp("promoted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyBatchIdx: index("enrichment_promotion_log_company_batch_idx").on(table.companyId, table.batchId),
  }),
);

/** Durable reviewer-cost reservations used to enforce each company's rolling cap. */
export const enrichmentReviewerReservations = pgTable(
  "enrichment_reviewer_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    queueRowId: uuid("queue_row_id").notNull().references(() => enrichmentQueue.id, { onDelete: "cascade" }),
    requestKey: text("request_key").notNull(),
    state: text("state").notNull().default("reserved"),
    reservedCents: integer("reserved_cents").notNull(),
    actualCents: integer("actual_cents"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => ({
    companyStateCreatedIdx: index("enrichment_reviewer_reservations_company_state_created_idx").on(
      table.companyId,
      table.state,
      table.createdAt,
    ),
    companyQueueRequestUq: uniqueIndex("enrichment_reviewer_reservations_company_queue_request_uq").on(
      table.companyId,
      table.queueRowId,
      table.requestKey,
    ),
  }),
);

/** Durable, idempotent delivery state for a reviewer budget-cap pause. */
export const enrichmentCapPauseEvents = pgTable(
  "enrichment_cap_pause_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    queueRowId: uuid("queue_row_id").references(() => enrichmentQueue.id, { onDelete: "set null" }),
    notificationKey: text("notification_key").notNull(),
    state: text("state").notNull().default("pending"),
    amountCents: integer("amount_cents").notNull(),
    errorClass: text("error_class"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
  },
  (table) => ({
    companyNotificationUq: uniqueIndex("enrichment_cap_pause_events_company_notification_uq").on(
      table.companyId,
      table.notificationKey,
    ),
    pendingIdx: index("enrichment_cap_pause_events_pending_idx").on(table.companyId, table.state, table.createdAt),
  }),
);

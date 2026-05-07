import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

/**
 * Company AI Builder — chat session.
 *
 * One row per "AI Builder conversation" against a single company. The Builder
 * runs through the existing service layer; sessions exist so transcripts,
 * costs, and audit can hang off a stable parent.
 *
 * @see doc/plans/2026-05-04-company-ai-builder.md §4
 */
export const builderSessions = pgTable(
  "builder_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id"),
    title: text("title").notNull().default(""),
    adapterType: text("adapter_type").notNull(),
    model: text("model").notNull(),
    state: text("state").notNull().default("active"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    inputTokensTotal: integer("input_tokens_total").notNull().default(0),
    outputTokensTotal: integer("output_tokens_total").notNull().default(0),
    costCentsTotal: integer("cost_cents_total").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("builder_sessions_company_idx").on(table.companyId),
    companyCreatedIdx: index("builder_sessions_company_created_idx").on(table.companyId, table.createdAt),
    companyArchivedCreatedIdx: index("builder_sessions_company_archived_created_idx").on(
      table.companyId,
      table.archivedAt,
      table.createdAt,
    ),
  }),
);

/**
 * Company AI Builder — message in a session transcript.
 *
 * `content` is JSON because messages can carry text, tool calls, or tool
 * results depending on `role`.
 */
export const builderMessages = pgTable(
  "builder_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => builderSessions.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    role: text("role").notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull().default({}),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionSeqUq: uniqueIndex("builder_messages_session_sequence_uq").on(table.sessionId, table.sequence),
    sessionIdx: index("builder_messages_session_idx").on(table.sessionId),
    companyIdx: index("builder_messages_company_idx").on(table.companyId),
  }),
);

/**
 * Company AI Builder — proposed mutation.
 *
 * Created by mutation tools (Phase 1+); Phase 0 leaves this table empty.
 * Proposals carry a typed `kind` and `payload` describing what the tool would
 * do; a board operator applies/rejects them. When applied, `appliedActivityId`
 * points to the activity-log entry that recorded the mutation.
 */
export const builderProposals = pgTable(
  "builder_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => builderSessions.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => builderMessages.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("pending"),
    appliedActivityId: uuid("applied_activity_id"),
    approvalId: uuid("approval_id"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("builder_proposals_company_idx").on(table.companyId),
    sessionIdx: index("builder_proposals_session_idx").on(table.sessionId),
    statusIdx: index("builder_proposals_company_status_idx").on(table.companyId, table.status),
    approvalIdIdx: index("builder_proposals_approval_id_idx")
      .on(table.approvalId)
      .where(sql`${table.approvalId} IS NOT NULL`),
  }),
);

/**
 * Company AI Builder — per-company adapter configuration.
 *
 * Stores which adapter the Builder uses for this company. Uses the same
 * adapter system as agents: adapterType + adapterConfig (JSONB).
 * Secrets are referenced via adapterConfig.env bindings with secret_ref.
 */
export const builderProviderSettings = pgTable(
  "builder_provider_settings",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    adapterType: text("adapter_type").notNull().default("claude_local"),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

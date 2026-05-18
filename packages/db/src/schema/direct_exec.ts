import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import type {
  DirectExecAnswerEvidenceByCategory,
  DirectExecContextConflict,
  DirectExecContextItem,
  DirectExecContextSourceFreshness,
  DirectExecLifecycle,
} from "@paperclipai/shared";

export const directExecThreads = pgTable(
  "direct_exec_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    originKind: text("origin_kind").notNull().default("direct_exec"),
    originId: text("origin_id").notNull(),
    originRunId: text("origin_run_id"),
    dedupeKey: text("dedupe_key").notNull(),
    sourceChannel: text("source_channel").notNull(),
    sourceChatId: text("source_chat_id").notNull(),
    sourceMessageId: text("source_message_id").notNull(),
    senderId: text("sender_id").notNull(),
    targetAlias: text("target_alias").notNull(),
    visibility: text("visibility").notNull(),
    lifecycleStatus: text("lifecycle_status").notNull().default("accepted"),
    lifecycle: jsonb("lifecycle").notNull().$type<DirectExecLifecycle>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDedupeUq: uniqueIndex("direct_exec_threads_company_dedupe_uq").on(table.companyId, table.dedupeKey),
    companyOriginUq: uniqueIndex("direct_exec_threads_company_origin_uq").on(table.companyId, table.originKind, table.originId),
    companySourceUq: uniqueIndex("direct_exec_threads_company_source_uq").on(
      table.companyId,
      table.sourceChannel,
      table.sourceChatId,
      table.sourceMessageId,
    ),
    companyStatusIdx: index("direct_exec_threads_company_status_idx").on(table.companyId, table.lifecycleStatus),
    issueIdx: index("direct_exec_threads_issue_idx").on(table.issueId),
    directExecOriginOnly: index("direct_exec_threads_origin_kind_check_idx").on(table.companyId, table.originKind).where(sql`${table.originKind} = 'direct_exec'`),
  }),
);

export const directExecContextBundles = pgTable(
  "direct_exec_context_bundles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    directExecThreadId: uuid("direct_exec_thread_id")
      .notNull()
      .references(() => directExecThreads.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    sources: jsonb("sources").notNull().$type<DirectExecContextSourceFreshness[]>(),
    items: jsonb("items").notNull().$type<DirectExecContextItem[]>(),
    conflicts: jsonb("conflicts").notNull().$type<DirectExecContextConflict[]>(),
    answerCategory: text("answer_category"),
    answerEvidence: jsonb("answer_evidence").notNull().$type<DirectExecAnswerEvidenceByCategory>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    threadUpdatedIdx: index("direct_exec_context_bundles_thread_updated_idx").on(table.directExecThreadId, table.updatedAt),
    companyIssueIdx: index("direct_exec_context_bundles_company_issue_idx").on(table.companyId, table.issueId),
  }),
);

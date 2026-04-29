import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const rt2V33KnowledgeVaultSettings = pgTable(
  "rt2_v33_knowledge_vault_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    vaultName: text("vault_name").notNull(),
    rootPath: text("root_path").notNull(),
    exportSubdirectory: text("export_subdirectory").notNull().default("rt2-export"),
    writerMode: text("writer_mode").notNull().default("dry_run"),
    lastDryRun: jsonb("last_dry_run").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("rt2_v33_knowledge_vault_settings_company_uq").on(table.companyId),
  }),
);

export const rt2V33KnowledgeSyncDecisions = pgTable(
  "rt2_v33_knowledge_sync_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pageKey: text("page_key").notNull(),
    filePath: text("file_path").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason").notNull(),
    actorId: text("actor_id").notNull().default("system"),
    beforeState: jsonb("before_state").$type<Record<string, unknown> | null>(),
    afterState: jsonb("after_state").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("rt2_v33_knowledge_sync_decisions_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    companyPageIdx: index("rt2_v33_knowledge_sync_decisions_company_page_idx").on(
      table.companyId,
      table.pageKey,
    ),
  }),
);

export const rt2V33KnowledgeBridgePairings = pgTable(
  "rt2_v33_knowledge_bridge_pairings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    bridgeName: text("bridge_name").notNull(),
    vaultName: text("vault_name").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("paired"),
    blockedReason: text("blocked_reason"),
    conflictCount: text("conflict_count").notNull().default("0"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastAppliedAt: timestamp("last_applied_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("rt2_v33_knowledge_bridge_pairings_company_uq").on(table.companyId),
    companyStatusIdx: index("rt2_v33_knowledge_bridge_pairings_company_status_idx").on(table.companyId, table.status),
  }),
);

export const rt2V33KnowledgeBridgeQueue = pgTable(
  "rt2_v33_knowledge_bridge_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    bridgeId: uuid("bridge_id").references(() => rt2V33KnowledgeBridgePairings.id, { onDelete: "set null" }),
    operation: text("operation").notNull(),
    status: text("status").notNull().default("queued"),
    pageKey: text("page_key"),
    vaultPath: text("vault_path"),
    candidateIds: jsonb("candidate_ids").$type<string[]>().notNull().default([]),
    blockedReason: text("blocked_reason"),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusIdx: index("rt2_v33_knowledge_bridge_queue_company_status_idx").on(table.companyId, table.status),
    companyCreatedIdx: index("rt2_v33_knowledge_bridge_queue_company_created_idx").on(table.companyId, table.createdAt),
  }),
);

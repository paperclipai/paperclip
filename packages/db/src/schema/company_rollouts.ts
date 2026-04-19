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
import type {
  CompanyPortabilityFileEntry,
  CompanyPortabilityManifest,
  CompanyRolloutCounts,
} from "@paperclipai/shared";
import { companies } from "./companies.js";

export const companyRolloutReleases = pgTable(
  "company_rollout_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceCompanyId: uuid("source_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    notes: text("notes"),
    manifestJson: jsonb("manifest_json").$type<CompanyPortabilityManifest>().notNull(),
    filesJson: jsonb("files_json").$type<Record<string, CompanyPortabilityFileEntry>>().notNull(),
    selectedFiles: jsonb("selected_files").$type<string[]>().notNull().default([]),
    packageHash: text("package_hash").notNull(),
    countsJson: jsonb("counts_json").$type<Record<string, number>>().notNull().default({}),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceVersionUq: uniqueIndex("company_rollout_releases_source_version_uq").on(
      table.sourceCompanyId,
      table.version,
    ),
    sourceCreatedIdx: index("company_rollout_releases_source_created_idx").on(
      table.sourceCompanyId,
      table.createdAt,
    ),
  }),
);

export const companyRolloutTargets = pgTable(
  "company_rollout_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id").notNull().references(() => companyRolloutReleases.id, { onDelete: "cascade" }),
    sourceCompanyId: uuid("source_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetCompanyId: uuid("target_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("previewed"),
    countsJson: jsonb("counts_json").$type<CompanyRolloutCounts>().notNull().default({
      create: 0,
      update: 0,
      skipNoChange: 0,
      skipUnmanagedConflict: 0,
      error: 0,
    }),
    entityActionsJson: jsonb("entity_actions_json").$type<Array<Record<string, unknown>>>().notNull().default([]),
    warningsJson: jsonb("warnings_json").$type<string[]>().notNull().default([]),
    errorsJson: jsonb("errors_json").$type<string[]>().notNull().default([]),
    applyResultJson: jsonb("apply_result_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    releaseTargetUq: uniqueIndex("company_rollout_targets_release_target_uq").on(
      table.releaseId,
      table.targetCompanyId,
    ),
    targetUpdatedIdx: index("company_rollout_targets_target_updated_idx").on(
      table.targetCompanyId,
      table.updatedAt,
    ),
  }),
);

export const companyRolloutEntityLinks = pgTable(
  "company_rollout_entity_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceCompanyId: uuid("source_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetCompanyId: uuid("target_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceEntityKind: text("source_entity_kind").notNull(),
    sourceEntityKey: text("source_entity_key").notNull(),
    sourceEntityHash: text("source_entity_hash").notNull(),
    targetEntityType: text("target_entity_type").notNull(),
    targetEntityId: text("target_entity_id").notNull(),
    releaseId: uuid("release_id").notNull().references(() => companyRolloutReleases.id, { onDelete: "cascade" }),
    lastAppliedAt: timestamp("last_applied_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceTargetEntityUq: uniqueIndex("company_rollout_entity_links_source_target_entity_uq").on(
      table.sourceCompanyId,
      table.targetCompanyId,
      table.sourceEntityKind,
      table.sourceEntityKey,
    ),
    targetEntityIdx: index("company_rollout_entity_links_target_entity_idx").on(
      table.targetCompanyId,
      table.targetEntityType,
      table.targetEntityId,
    ),
  }),
);

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
import { nativeHarnessBackups } from "./native_harness_backups.js";

export const nativeProviderArtifacts = pgTable(
  "native_provider_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    closureDigest: text("closure_digest").notNull(),
    status: text("status").notNull().default("pending"),
    uploadToken: uuid("upload_token"),
    descriptor: jsonb("descriptor").$type<Record<string, unknown>>().notNull(),
    reference: jsonb("reference").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    digest: uniqueIndex("native_provider_artifacts_company_digest_idx")
      .on(table.companyId, table.closureDigest)
      .where(sql`${table.status} = 'ready'`),
  }),
);

export const nativeProviderArtifactReferences = pgTable(
  "native_provider_artifact_references",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => nativeProviderArtifacts.id, { onDelete: "restrict" }),
    runId: uuid("run_id").notNull(),
    backupId: uuid("backup_id").references(() => nativeHarnessBackups.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    artifact: index("native_provider_artifact_references_artifact_idx").on(
      table.companyId,
      table.artifactId,
    ),
    run: uniqueIndex("native_provider_artifact_references_run_idx")
      .on(table.companyId, table.runId, table.artifactId)
      .where(sql`${table.backupId} is null`),
    backup: uniqueIndex("native_provider_artifact_references_backup_idx")
      .on(table.companyId, table.artifactId, table.backupId)
      .where(sql`${table.backupId} is not null`),
  }),
);

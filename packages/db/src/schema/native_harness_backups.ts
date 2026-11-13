import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const nativeHarnessBackups = pgTable("native_harness_backups", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  runId: uuid("run_id").notNull(),
  scopeDigest: text("scope_digest").notNull(),
  manifestSha256: text("manifest_sha256").notNull(),
  status: text("status").notNull().default("pending"),
  reference: jsonb("reference").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  current: uniqueIndex("native_harness_backups_current_idx").on(table.companyId, table.scopeDigest)
    .where(sql`${table.status} = 'current'`),
  scope: index("native_harness_backups_scope_idx").on(table.companyId, table.scopeDigest, table.manifestSha256),
}));

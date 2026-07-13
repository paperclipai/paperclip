import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export type SeoDocCadence = "weekly" | "biweekly" | "monthly";
export type SeoDocStatus = "active" | "stale" | "deprecated";
export type SeoDocClass =
  | "strategy"
  | "implementation"
  | "runbook"
  | "incident"
  | "experimentation"
  | "architecture"
  | "governance";

export type SeoDocCriticality = "normal" | "critical";

export interface SeoDocDependencyRef {
  type: "issue_document" | "issue";
  target: string;
  role: "source_strategy" | "implementation_handoff" | "related";
}

export const seoDocRegistryEntries = pgTable(
  "seo_doc_registry_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    docKey: text("doc_key").notNull(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    issueDocumentKey: text("issue_document_key").notNull(),
    title: text("title").notNull(),
    issueLink: text("issue_link").notNull(),
    owner: text("owner").notNull(),
    lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull(),
    updateCadence: text("update_cadence").$type<SeoDocCadence>().notNull(),
    status: text("status").$type<SeoDocStatus>().notNull().default("active"),
    dependencies: jsonb("dependencies").$type<SeoDocDependencyRef[]>().notNull().default([]),
    documentClass: text("document_class").$type<SeoDocClass>().notNull(),
    criticality: text("criticality").$type<SeoDocCriticality>().notNull().default("normal"),
    lastAuditedAt: timestamp("last_audited_at", { withTimezone: true }),
    lastEscalatedAt: timestamp("last_escalated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDocKeyUq: uniqueIndex("seo_doc_registry_entries_company_doc_key_uq").on(table.companyId, table.docKey),
    companyStatusIdx: index("seo_doc_registry_entries_company_status_idx").on(table.companyId, table.status),
    companyIssueIdx: index("seo_doc_registry_entries_company_issue_idx").on(table.companyId, table.issueId),
    companyLastUpdatedIdx: index("seo_doc_registry_entries_company_last_updated_idx").on(
      table.companyId,
      table.lastUpdated,
    ),
    cadenceCheck: check(
      "seo_doc_registry_entries_update_cadence_check",
      sql`${table.updateCadence} in ('weekly', 'biweekly', 'monthly')`,
    ),
    statusCheck: check(
      "seo_doc_registry_entries_status_check",
      sql`${table.status} in ('active', 'stale', 'deprecated')`,
    ),
    documentClassCheck: check(
      "seo_doc_registry_entries_document_class_check",
      sql`${table.documentClass} in ('strategy', 'implementation', 'runbook', 'incident', 'experimentation', 'architecture', 'governance')`,
    ),
    criticalityCheck: check(
      "seo_doc_registry_entries_criticality_check",
      sql`${table.criticality} in ('normal', 'critical')`,
    ),
  }),
);

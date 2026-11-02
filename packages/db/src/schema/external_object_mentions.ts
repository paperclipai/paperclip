import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ExternalObjectMentionConfidence, ExternalObjectMentionSourceKind } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { externalObjects } from "./external_objects.js";
import { issues } from "./issues.js";
import { plugins } from "./plugins.js";

export const externalObjectMentions = pgTable(
  "external_object_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").$type<ExternalObjectMentionSourceKind>().notNull(),
    sourceRecordId: uuid("source_record_id"),
    documentKey: text("document_key"),
    propertyKey: text("property_key"),
    matchedTextRedacted: text("matched_text_redacted"),
    sanitizedDisplayUrl: text("sanitized_display_url"),
    canonicalIdentityHash: text("canonical_identity_hash"),
    canonicalIdentity: jsonb("canonical_identity").$type<Record<string, unknown>>(),
    objectId: uuid("object_id").references(() => externalObjects.id, { onDelete: "set null" }),
    providerKey: text("provider_key"),
    detectorKey: text("detector_key"),
    objectType: text("object_type"),
    confidence: text("confidence").$type<ExternalObjectMentionConfidence>().notNull().default("exact"),
    createdByPluginId: uuid("created_by_plugin_id").references(() => plugins.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceIssueIdx: index("external_object_mentions_company_source_issue_idx").on(
      table.companyId,
      table.sourceIssueId,
    ),
    companyObjectIdx: index("external_object_mentions_company_object_idx").on(table.companyId, table.objectId),
    companyProviderIdx: index("external_object_mentions_company_provider_idx").on(
      table.companyId,
      table.providerKey,
      table.objectType,
    ),
    companySourceMentionWithRecordUq: uniqueIndex("external_object_mentions_company_source_record_uq").on(
      table.companyId,
      table.sourceIssueId,
      table.sourceKind,
      table.sourceRecordId,
      table.documentKey,
      table.propertyKey,
      table.canonicalIdentityHash,
    ).where(sql`${table.sourceRecordId} is not null and ${table.canonicalIdentityHash} is not null`),
    companySourceMentionWithoutRecordUq: uniqueIndex("external_object_mentions_company_source_null_record_uq").on(
      table.companyId,
      table.sourceIssueId,
      table.sourceKind,
      table.documentKey,
      table.propertyKey,
      table.canonicalIdentityHash,
    ).where(sql`${table.sourceRecordId} is null and ${table.canonicalIdentityHash} is not null`),
  }),
);

import { pgEnum, pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { estateAssets } from "./estate_assets.js";

export const documentAlertTypeEnum = pgEnum("document_alert_type", [
  "insurance_renewal",
  "lease_expiration",
  "appraisal_due",
  "license_expiration",
  "tax_filing_deadline",
  "other",
]);

export const documentAlertStatusEnum = pgEnum("document_alert_status", [
  "active",
  "dismissed",
  "expired",
]);

export const estateDocumentAlerts = pgTable(
  "estate_document_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    assetId: uuid("asset_id").references(() => estateAssets.id, { onDelete: "set null" }),
    documentName: text("document_name").notNull(),
    alertType: documentAlertTypeEnum("alert_type").notNull().default("other"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    alertDaysBefore: integer("alert_days_before").array().notNull().default([30, 60, 90]),
    lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true }),
    status: documentAlertStatusEnum("status").notNull().default("active"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("estate_doc_alerts_company_user_idx").on(table.companyId, table.userId),
    assetIdx: index("estate_doc_alerts_asset_idx").on(table.assetId),
  }),
);

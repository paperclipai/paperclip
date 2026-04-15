import { index, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const boardBriefAlertEvents = pgTable(
  "board_brief_alert_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    fingerprint: text("fingerprint").notNull(),
    incidentType: text("incident_type").notNull(),
    severity: text("severity").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    status: text("status").notNull().default("active"),
    firstDetectedAt: timestamp("first_detected_at", { withTimezone: true }).notNull(),
    lastDetectedAt: timestamp("last_detected_at", { withTimezone: true }).notNull(),
    firstSentAt: timestamp("first_sent_at", { withTimezone: true }),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    lastSnapshotId: uuid("last_snapshot_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyFingerprintUq: uniqueIndex("board_brief_alert_events_company_fingerprint_uq").on(
      table.companyId,
      table.fingerprint,
    ),
    companyStatusSeverityUpdatedIdx: index("board_brief_alert_events_company_status_severity_updated_idx").on(
      table.companyId,
      table.status,
      table.severity,
      table.updatedAt,
    ),
  }),
);

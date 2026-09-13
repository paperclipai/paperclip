import {
  pgEnum,
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { solarisAlerts } from "./solaris_alerts.js";

export const irwinExportStatusEnum = pgEnum("irwin_export_status", [
  "pending",
  "in_flight",
  "success",
  "failed",
  "skipped",
]);

export const irwinIncidentClassificationEnum = pgEnum("irwin_incident_classification", [
  "reportable",   // confirmed wildland fire — POST to IRWIN IRS-209
  "informational", // fire weather/risk alerts — informational feed only
]);

export const irwinExportQueue = pgTable(
  "irwin_export_queue",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    solarisAlertId: uuid("solaris_alert_id")
      .notNull()
      .references(() => solarisAlerts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    status: irwinExportStatusEnum("status").notNull().default("pending"),
    classification: irwinIncidentClassificationEnum("classification")
      .notNull()
      .default("informational"),
    irwinIncidentId: text("irwin_incident_id"),       // UUID assigned by IRWIN after successful POST
    irwinIncidentNumber: text("irwin_incident_number"), // e.g. "CAC-STF-020571"
    payload: jsonb("payload").notNull(),               // serialized IRS209_Fire payload sent/to-send
    lastError: text("last_error"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusNextAttemptIdx: index("irwin_export_queue_status_next_attempt_idx").on(
      t.status,
      t.nextAttemptAt,
    ),
    companyCreatedIdx: index("irwin_export_queue_company_created_idx").on(
      t.companyId,
      t.createdAt,
    ),
    alertIdx: index("irwin_export_queue_alert_idx").on(t.solarisAlertId),
  }),
);

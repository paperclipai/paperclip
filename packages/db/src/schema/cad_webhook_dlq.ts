import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const cadDlqStatusEnum = pgEnum("cad_dlq_status", ["pending", "exhausted", "replayed"]);

export const cadWebhookDlq = pgTable(
  "cad_webhook_dlq",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    agencyCode: text("agency_code").notNull(),
    incidentId: text("incident_id"),
    rawPayload: text("raw_payload").notNull(),
    contentType: text("content_type").notNull(),
    vendor: text("vendor").notNull().default("generic"),
    errorReason: text("error_reason").notNull(),
    attemptCount: integer("attempt_count").notNull().default(1),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    status: cadDlqStatusEnum("status").notNull().default("pending"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusRetryIdx: index("cad_webhook_dlq_status_retry_idx").on(t.status, t.nextRetryAt),
    agencyIncidentIdx: index("cad_webhook_dlq_agency_incident_idx").on(t.agencyCode, t.incidentId),
  }),
);

import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * The instance-side durable receipt for normalized connector events.
 *
 * Cloud remains the delivery queue. This table makes applying a leased event
 * transactional and idempotent when a lease expires before its acknowledgement
 * reaches Cloud. Raw provider webhook bodies must never be stored here.
 */
export const connectionEventDeliveries = pgTable(
  "connection_event_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerDeliveryId: text("provider_delivery_id").notNull(),
    event: text("event").notNull(),
    action: text("action"),
    installationId: text("installation_id"),
    repositoryId: text("repository_id"),
    normalizedPayload: jsonb("normalized_payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<"received" | "processed" | "failed">().notNull().default("received"),
    attempts: integer("attempts").notNull().default(1),
    lastError: text("last_error"),
    providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("connection_event_deliveries_company_provider_id_uq").on(
      table.companyId,
      table.provider,
      table.providerDeliveryId,
    ),
    index("connection_event_deliveries_company_status_idx").on(table.companyId, table.status, table.createdAt),
  ],
);

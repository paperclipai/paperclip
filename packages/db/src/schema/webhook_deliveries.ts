import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { webhookEndpoints } from "./webhook_endpoints.js";
import type { WebhookDeliveryStatus, WebhookEventType } from "@paperclipai/shared";

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventType: text("event_type").$type<WebhookEventType>().notNull(),
    status: text("status").$type<WebhookDeliveryStatus>().notNull().default("pending"),
    attempt: integer("attempt").notNull().default(1),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms"),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    responseBody: text("response_body"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    webhookIdx: index("webhook_deliveries_webhook_idx").on(table.webhookId),
    statusIdx: index("webhook_deliveries_status_idx").on(table.status),
    nextAttemptIdx: index("webhook_deliveries_next_attempt_idx").on(table.nextAttemptAt),
  }),
);

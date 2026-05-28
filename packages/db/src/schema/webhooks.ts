import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  integer,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import type { WebhookEventType, WebhookDeliveryStatus } from "@paperclipai/shared";

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    eventTypes: jsonb("event_types").$type<WebhookEventType[]>().notNull(),
    metadataFilter: jsonb("metadata_filter").$type<Record<string, unknown>>(),
    description: text("description"),
    active: text("active").notNull().default("true"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("webhooks_company_idx").on(table.companyId),
    companyActiveIdx: index("webhooks_company_active_idx").on(table.companyId, table.active),
  }),
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    eventType: text("event_type").$type<WebhookEventType>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<WebhookDeliveryStatus>().notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    error: text("error"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    webhookIdx: index("webhook_deliveries_webhook_idx").on(table.webhookId),
    statusIdx: index("webhook_deliveries_status_idx").on(table.status),
    retryIdx: index("webhook_deliveries_retry_idx").on(table.status, table.nextRetryAt),
  }),
);

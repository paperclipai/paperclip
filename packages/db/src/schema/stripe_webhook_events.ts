import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Stripe webhook events — deduplication table for at-least-once delivery.
 * Every processed Stripe webhook event ID is recorded here with a UNIQUE constraint
 * to prevent duplicate processing (Stripe delivers webhooks at-least-once).
 */
export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    stripeEventId: text("stripe_event_id").notNull(),
    eventType: text("event_type").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stripeEventIdIdx: uniqueIndex("stripe_webhook_events_event_id_idx").on(table.stripeEventId),
  }),
);
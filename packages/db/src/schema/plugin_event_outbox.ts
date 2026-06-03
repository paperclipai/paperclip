import { pgTable, uuid, text, timestamp, jsonb, integer, bigserial, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Cross-tier delivery outbox for plugin domain events.
 *
 * Plugin event subscriptions live in an in-memory registry on the worker tier
 * only (plugins load there). REST routes run on the API tier, so an event
 * published there would never reach a subscribed plugin. This table is the
 * durable hand-off: any tier INSERTs the serialized PluginEvent here, and a
 * single worker-tier poller is the sole emitter — claiming queued rows,
 * dispatching them to the in-process bus, and marking them processed. One
 * writer + one emitter ⇒ no double-delivery.
 */
export const pluginEventOutbox = pgTable(
  "plugin_event_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonic insertion order — drives deterministic FIFO delivery. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    /** The PluginEvent.eventId (for tracing; not unique). */
    eventId: uuid("event_id").notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    eventType: text("event_type").notNull(),
    /** queued → processing → processed | failed */
    status: text("status").notNull().default("queued"),
    /** The entire serialized PluginEvent, reconstructed verbatim on emit. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => ({
    statusSeqIdx: index("plugin_event_outbox_status_seq_idx").on(
      table.status,
      table.seq,
    ),
  }),
);

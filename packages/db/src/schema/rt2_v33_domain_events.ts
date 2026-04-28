import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const rt2V33DomainEvents = pgTable(
  "rt2_v33_domain_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    eventVersion: integer("event_version").notNull().default(1),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    commandId: text("command_id"),
    correlationId: text("correlation_id"),
    causationId: uuid("causation_id"),
    idempotencyKey: text("idempotency_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    actorTypeCheck: check(
      "rt2_v33_domain_events_actor_type_check",
      sql`${table.actorType} in ('user', 'agent', 'system', 'runtime')`,
    ),
    companyOccurredIdx: index("rt2_v33_domain_events_company_occurred_idx").on(
      table.companyId,
      table.occurredAt,
    ),
    companyTypeOccurredIdx: index("rt2_v33_domain_events_company_type_occurred_idx").on(
      table.companyId,
      table.eventType,
      table.occurredAt,
    ),
    entityIdx: index("rt2_v33_domain_events_entity_idx").on(
      table.companyId,
      table.entityType,
      table.entityId,
    ),
    companyIdempotencyUq: uniqueIndex("rt2_v33_domain_events_company_idempotency_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  }),
);

export const rt2V33ProjectorState = pgTable(
  "rt2_v33_projector_state",
  {
    projectorName: text("projector_name").primaryKey(),
    status: text("status").notNull().default("idle"),
    lastEventId: uuid("last_event_id"),
    lastProcessedAt: timestamp("last_processed_at", { withTimezone: true }),
    failureCount: integer("failure_count").notNull().default(0),
    lastError: text("last_error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      "rt2_v33_projector_state_status_check",
      sql`${table.status} in ('idle', 'running', 'failed')`,
    ),
  }),
);

export const rt2V33ProjectorEvents = pgTable(
  "rt2_v33_projector_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectorName: text("projector_name").notNull(),
    eventId: uuid("event_id").notNull().references(() => rt2V33DomainEvents.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    error: text("error"),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      "rt2_v33_projector_events_status_check",
      sql`${table.status} in ('processed', 'failed')`,
    ),
    projectorEventUq: uniqueIndex("rt2_v33_projector_events_projector_event_uq").on(
      table.projectorName,
      table.eventId,
    ),
    eventIdx: index("rt2_v33_projector_events_event_idx").on(table.eventId),
  }),
);

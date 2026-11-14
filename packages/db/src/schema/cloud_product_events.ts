import { sql } from "drizzle-orm";
import { bigint, bigserial, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export type CloudProductEventProperties = Record<string, string | number | boolean>;

export const cloudProductEvents = pgTable(
  "cloud_product_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    transactionId: bigint("transaction_id", { mode: "bigint" }).notNull().default(sql`txid_current()`),
    eventId: uuid("event_id").notNull().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    responsibleUserId: text("responsible_user_id"),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    properties: jsonb("properties").$type<CloudProductEventProperties>().notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    eventIdUq: uniqueIndex("cloud_product_events_event_id_uq").on(table.eventId),
    companyCursorIdx: index("cloud_product_events_company_cursor_idx").on(table.companyId, table.transactionId, table.id),
    occurredAtIdx: index("cloud_product_events_occurred_at_idx").on(table.occurredAt),
  }),
);

import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, bigserial } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const crossCompanyMessages = pgTable(
  "cross_company_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cursor: bigserial("cursor", { mode: "number" }).notNull(),
    sourceCompanyId: uuid("source_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceAgentId: uuid("source_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    destinationCompanyId: uuid("destination_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    messageType: text("message_type").notNull(),
    payload: jsonb("payload").notNull(),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    ackedByAgentId: uuid("acked_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cursorUniqueIdx: uniqueIndex("cross_company_messages_cursor_uq").on(table.cursor),
    sourceIdempotencyUniqueIdx: uniqueIndex("cross_company_messages_source_idempotency_uq").on(
      table.sourceCompanyId,
      table.destinationCompanyId,
      table.idempotencyKey,
    ),
    destinationCursorIdx: index("cross_company_messages_destination_cursor_idx").on(
      table.destinationCompanyId,
      table.cursor,
    ),
    sourceCursorIdx: index("cross_company_messages_source_cursor_idx").on(
      table.sourceCompanyId,
      table.cursor,
    ),
    destinationAckCursorIdx: index("cross_company_messages_destination_ack_cursor_idx").on(
      table.destinationCompanyId,
      table.ackedAt,
      table.cursor,
    ),
  }),
);

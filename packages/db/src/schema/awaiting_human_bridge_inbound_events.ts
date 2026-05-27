import { index, pgTable, text, timestamp, uniqueIndex, uuid, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { awaitingHumanBridges } from "./awaiting_human_bridges.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";

export const awaitingHumanBridgeInboundEvents = pgTable(
  "awaiting_human_bridge_inbound_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bridgeId: uuid("bridge_id").notNull().references(() => awaitingHumanBridges.id),
    interactionId: uuid("interaction_id").notNull().references(() => issueThreadInteractions.id),
    eventKind: text("event_kind").notNull().$type<"reply" | "approval_signal" | "reject_signal">(),
    externalEventId: text("external_event_id"),
    externalMessageId: text("external_message_id"),
    externalThreadId: text("external_thread_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bridgeCreatedAtIdx: index("awaiting_human_bridge_inbound_events_bridge_created_at_idx").on(
      table.bridgeId,
      table.createdAt,
    ),
    interactionExternalEventUniqueIdx: uniqueIndex("awaiting_human_bridge_inbound_events_interaction_event_uq")
      .on(table.interactionId, table.externalEventId)
      .where(sql`${table.externalEventId} IS NOT NULL`),
  }),
);

import type { PubsubEnvelope } from "@paperclipai/shared";
import { foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const pubsubTrust = pgTable("pubsub_trust", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  peerInstanceId: uuid("peer_instance_id").notNull(),
  peerCompanyId: uuid("peer_company_id").notNull(),
  publicKey: text("public_key").notNull(),
  url: text("url").notNull(),
  topics: jsonb("topics").$type<string[]>().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({ companyPeer: uniqueIndex("pubsub_trust_company_peer_idx").on(table.companyId, table.peerInstanceId) }));

export const pubsubSubscriptions = pgTable("pubsub_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  peerInstanceId: uuid("peer_instance_id").notNull(),
  topic: text("topic").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({ companyPeerTopic: uniqueIndex("pubsub_subscriptions_company_peer_topic_idx").on(table.companyId, table.peerInstanceId, table.topic) }));

/** A single retained history row per local-company/message; inbox is its incoming projection. */
export const pubsubMessages = pgTable("pubsub_messages", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  id: uuid("id").notNull(),
  direction: text("direction").$type<"incoming" | "outgoing">().notNull(),
  topic: text("topic").notNull(),
  payload: jsonb("payload").$type<unknown>().notNull(),
  fromInstance: uuid("from_instance").notNull(),
  fromCompany: uuid("from_company").notNull(),
  fromAgent: uuid("from_agent"),
  fromRole: text("from_role").$type<"ceo" | "board" | "system">().notNull(),
  contentHash: text("content_hash").notNull(),
  envelope: jsonb("envelope").$type<PubsubEnvelope>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  ackedAt: timestamp("acked_at", { withTimezone: true }),
  deliveryCount: integer("delivery_count").notNull().default(0),
  nextVisibleAt: timestamp("next_visible_at", { withTimezone: true }).notNull().defaultNow(),
  wakePending: integer("wake_pending").notNull().default(0),
  wakeAttempts: integer("wake_attempts").notNull().default(0),
  wakeAvailableAt: timestamp("wake_available_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.companyId, table.id] }),
  history: index("pubsub_messages_history_idx").on(table.companyId, table.topic, table.createdAt, table.id),
  inbox: index("pubsub_messages_inbox_idx").on(table.companyId, table.direction, table.ackedAt, table.nextVisibleAt),
  wake: index("pubsub_messages_wake_idx").on(table.wakePending, table.wakeAvailableAt),
  prune: index("pubsub_messages_prune_idx").on(table.ackedAt),
}));

export const pubsubOutbox = pgTable("pubsub_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  messageId: uuid("message_id").notNull(),
  peerInstanceId: uuid("peer_instance_id").notNull(),
  peerCompanyId: uuid("peer_company_id").notNull(),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  message: foreignKey({ columns: [table.companyId, table.messageId], foreignColumns: [pubsubMessages.companyId, pubsubMessages.id] }).onDelete("cascade"),
  recipient: uniqueIndex("pubsub_outbox_message_peer_idx").on(table.companyId, table.messageId, table.peerInstanceId),
  pending: index("pubsub_outbox_pending_idx").on(table.deliveredAt, table.cancelledAt, table.availableAt),
}));

export const pubsubNonces = pgTable("pubsub_nonces", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  peerInstanceId: uuid("peer_instance_id").notNull(),
  nonce: uuid("nonce").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.companyId, table.peerInstanceId, table.nonce] }),
  retention: index("pubsub_nonces_retention_idx").on(table.companyId, table.receivedAt),
}));

export const pubsubObservers = pgTable("pubsub_observers", {
  companyId: uuid("company_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.companyId, table.agentId] }),
  agent: foreignKey({ columns: [table.companyId, table.agentId], foreignColumns: [agents.companyId, agents.id] }).onDelete("cascade"),
}));

export const pubsubActivityReceipts = pgTable("pubsub_activity_receipts", {
  eventId: uuid("event_id").notNull(),
  topic: text("topic").notNull(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({ pk: primaryKey({ columns: [table.eventId, table.topic] }) }));

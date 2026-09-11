import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  foreignKey,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import type {
  EmailEnvelope,
  EmailDeliveryOutcome,
  EmailSendInput,
} from "@paperclipai/shared";
import {
  chatEndpoints,
  chatConversations,
  chatPublications,
} from "./chat_channels.js";

/** Email-specific state; conversations, delivery queues and send outboxes remain shared. */
export const emailEndpoints = pgTable(
  "email_endpoints",
  {
    endpointId: uuid("endpoint_id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    receiveMode: text("receive_mode")
      .$type<"websocket" | "webhook">()
      .notNull(),
    webhookId: text("webhook_id"),
    ownedApiKeyId: text("owned_api_key_id"),
    activationAt: timestamp("activation_at", { withTimezone: true }),
    syncCheckpoint: timestamp("sync_checkpoint", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "email_endpoints_receive_mode_check",
      sql`${t.receiveMode} in ('websocket', 'webhook')`,
    ),
    foreignKey({
      columns: [t.companyId, t.endpointId],
      foreignColumns: [chatEndpoints.companyId, chatEndpoints.id],
    }).onDelete("cascade"),
  ],
);

export const emailMessages = pgTable(
  "email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    endpointId: uuid("endpoint_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    envelope: jsonb("envelope").$type<EmailEnvelope>().notNull(),
    text: text("text").notNull(),
    fullText: text("full_text").notNull().default(""),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    automatic: boolean("automatic").notNull().default(false),
    attachmentIds: jsonb("attachment_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "email_messages_direction_check",
      sql`${t.direction} in ('inbound', 'outbound')`,
    ),
    uniqueIndex("email_messages_provider_uq").on(
      t.endpointId,
      t.providerMessageId,
    ),
    index("email_messages_conversation_idx").on(
      t.companyId,
      t.conversationId,
      t.timestamp,
    ),
    foreignKey({
      columns: [t.companyId, t.endpointId],
      foreignColumns: [chatEndpoints.companyId, chatEndpoints.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.companyId, t.conversationId],
      foreignColumns: [chatConversations.companyId, chatConversations.id],
    }).onDelete("cascade"),
  ],
);

export const emailSends = pgTable(
  "email_sends",
  {
    publicationId: uuid("publication_id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    endpointId: uuid("endpoint_id").notNull(),
    request: jsonb("request").$type<EmailSendInput>().notNull(),
    actor: jsonb("actor")
      .$type<{
        userId?: string;
        agentId?: string;
        runId?: string;
        localImplicit?: boolean;
      }>()
      .notNull(),
    digest: text("digest").notNull(),
    outcome: text("outcome")
      .$type<EmailDeliveryOutcome>()
      .notNull()
      .default("queued"),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.companyId, t.endpointId],
      foreignColumns: [chatEndpoints.companyId, chatEndpoints.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.companyId, t.publicationId],
      foreignColumns: [chatPublications.companyId, chatPublications.id],
    }).onDelete("cascade"),
    check(
      "email_sends_outcome_check",
      sql`${t.outcome} in ('queued', 'sent', 'delivered', 'failed', 'uncertain')`,
    ),
    index("email_sends_pending_idx")
      .on(t.endpointId, t.outcome)
      .where(sql`${t.outcome} in ('queued', 'uncertain')`),
  ],
);

import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";
import { agents, companies, authUsers } from "./index.js";

// Enums for messaging platforms and statuses
export const messagingPlatformEnum = pgEnum("messaging_platform", [
  "telegram",
  "whatsapp",
  "slack",
  "email",
]);

export const messagingConnectorStatusEnum = pgEnum("messaging_connector_status", [
  "active",
  "inactive",
  "error",
]);

export const messagingChannelTypeEnum = pgEnum("messaging_channel_type", [
  "direct",
  "group",
  "channel",
]);

export const messagingDirectionEnum = pgEnum("messaging_direction", [
  "inbound",
  "outbound",
]);

export const messagingStatusEnum = pgEnum("messaging_status", [
  "pending",
  "sent",
  "delivered",
  "read",
  "failed",
]);

export const messagingWebhookStatusEnum = pgEnum("messaging_webhook_status", [
  "processed",
  "failed",
  "pending_retry",
]);

/**
 * Messaging platforms/connectors
 */
export const messagingConnectors = pgTable(
  "messaging_connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    platform: messagingPlatformEnum("platform").notNull(),
    name: text("name").notNull(),
    configuration: jsonb("configuration").$type<Record<string, unknown>>().notNull(), // API keys, tokens, webhook URLs, etc.
    status: messagingConnectorStatusEnum("status").notNull().default("inactive"),
    errorMessage: text("error_message"),
    webhookUrl: text("webhook_url"),
    webhookSecret: text("webhook_secret"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("messaging_connectors_company_idx").on(table.companyId),
    platformIdx: index("messaging_connectors_platform_idx").on(table.platform),
  })
);

/**
 * Messaging channels (agent-specific message endpoints)
 */
export const messagingChannels = pgTable(
  "messaging_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => messagingConnectors.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelIdentifier: text("channel_identifier").notNull(), // Telegram chat ID, Slack channel, email, etc.
    channelType: messagingChannelTypeEnum("channel_type"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    enabled: boolean("enabled").default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentIdx: index("messaging_channels_agent_idx").on(table.agentId),
    connectorIdx: index("messaging_channels_connector_idx").on(table.connectorId),
    uniqueChannel: uniqueIndex("messaging_channels_unique").on(
      table.connectorId,
      table.agentId,
      table.channelIdentifier
    ),
  })
);

/**
 * Message history (inbound and outbound messages)
 */
export const messagingMessages = pgTable(
  "messaging_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => messagingChannels.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    direction: messagingDirectionEnum("direction").notNull(),
    platformMessageId: text("platform_message_id"), // External message ID
    senderIdentifier: text("sender_identifier"), // User ID in external platform
    senderName: text("sender_name"),
    content: text("content").notNull(),
    contentType: text("content_type"), // 'text', 'media', 'media_url'
    mediaUrl: text("media_url"),
    attachmentData: jsonb("attachment_data").$type<Record<string, unknown>>(),
    status: messagingStatusEnum("status"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    channelIdx: index("messaging_messages_channel_idx").on(table.channelId),
    agentIdx: index("messaging_messages_agent_idx").on(table.agentId),
    createdIdx: index("messaging_messages_created_idx").on(table.createdAt),
  })
);

/**
 * Message processing logs
 */
export const messagingWebhooks = pgTable(
  "messaging_webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => messagingConnectors.id, { onDelete: "cascade" }),
    webhookEvent: text("webhook_event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: messagingWebhookStatusEnum("status"),
    errorMessage: text("error_message"),
    retryCount: integer("retry_count").default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => ({
    connectorIdx: index("messaging_webhooks_connector_idx").on(table.connectorId),
    statusIdx: index("messaging_webhooks_status_idx").on(table.status),
  })
);

/**
 * User mappings (connect external users to agents)
 */
export const messagingUserMappings = pgTable(
  "messaging_user_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => messagingConnectors.id, { onDelete: "cascade" }),
    externalUserId: text("external_user_id").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    externalMetadata: jsonb("external_metadata").$type<Record<string, unknown>>(), // Name, avatar, etc.
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    connectorIdx: index("messaging_user_mappings_connector_idx").on(table.connectorId),
    agentIdx: index("messaging_user_mappings_agent_idx").on(table.agentId),
    uniqueMapping: uniqueIndex("messaging_user_mappings_unique").on(
      table.connectorId,
      table.externalUserId
    ),
  })
);

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ChatAdapterCapabilities,
  ChatConcurrencyPolicy,
  ChatDeliveryState,
  ChatDeploymentMode,
  ChatEndpointSetupState,
  ChatEndpointStatus,
  ChatEventKind,
  ChatIdentityLinkStatus,
  ChatPrincipalKind,
  ChatProvider,
  ChatPublicationState,
  ChatResourceAvailability,
  SafeChatPublicationPayload,
} from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";
import { toolConnections } from "./tool_access.js";

export const chatEndpoints = pgTable(
  "chat_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    provider: text("provider").$type<ChatProvider>().notNull(),
    publicId: text("public_id").notNull(),
    assignedAgentId: uuid("assigned_agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    sponsorUserId: text("sponsor_user_id"),
    status: text("status").$type<ChatEndpointStatus>().notNull().default("draft"),
    deploymentMode: text("deployment_mode").$type<ChatDeploymentMode>().notNull().default("direct"),
    providerAccountId: text("provider_account_id"),
    providerAccountLabel: text("provider_account_label"),
    botExternalId: text("bot_external_id"),
    botUsername: text("bot_username"),
    botDisplayName: text("bot_display_name"),
    botAvatarUrl: text("bot_avatar_url"),
    allowDirectMessages: boolean("allow_direct_messages").notNull().default(true),
    allowGroupChats: boolean("allow_group_chats").notNull().default(false),
    allowUnlinkedPeople: boolean("allow_unlinked_people").notNull().default(true),
    concurrencyPolicy: text("concurrency_policy").$type<ChatConcurrencyPolicy>().notNull().default("queue"),
    capabilities: jsonb("capabilities").$type<ChatAdapterCapabilities>().notNull().default({
      threads: false,
      directMessages: false,
      nativeStreaming: false,
      messageEdits: false,
      messageDeletes: false,
      reactions: false,
      files: false,
      cards: false,
      actions: false,
      modals: false,
      slashCommands: false,
      ephemeralMessages: false,
      proactiveDirectMessages: false,
    }),
    setup: jsonb("setup").$type<ChatEndpointSetupState>().notNull().default({ step: "provider_setup" }),
    healthMessage: text("health_message"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    lastPublicationAt: timestamp("last_publication_at", { withTimezone: true }),
    lastError: text("last_error"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("chat_endpoints_provider_check", sql`${table.provider} in ('slack', 'github', 'microsoft-teams', 'telegram')`),
    check("chat_endpoints_status_check", sql`${table.status} in ('draft', 'verifying', 'active', 'paused', 'attention', 'revoked', 'archived')`),
    check("chat_endpoints_deployment_check", sql`${table.deploymentMode} in ('direct', 'relay')`),
    check("chat_endpoints_concurrency_check", sql`${table.concurrencyPolicy} in ('burst', 'queue', 'debounce', 'drop', 'concurrent')`),
    index("chat_endpoints_company_idx").on(table.companyId),
    index("chat_endpoints_agent_idx").on(table.companyId, table.assignedAgentId),
    index("chat_endpoints_status_idx").on(table.companyId, table.status),
    uniqueIndex("chat_endpoints_public_id_uq").on(table.publicId),
    uniqueIndex("chat_endpoints_connection_uq").on(table.connectionId),
    // A native provider identity can back only one live Paperclip endpoint.
    // Historical archived/revoked endpoints retain attribution without
    // preventing an operator from deliberately reusing the provider bot later.
    uniqueIndex("chat_endpoints_live_bot_external_uq")
      .on(table.provider, table.providerAccountId, table.botExternalId)
      .where(
        sql`${table.status} in ('verifying', 'active', 'paused', 'attention')
          and ${table.providerAccountId} is not null
          and ${table.botExternalId} is not null`,
      ),
    // GitHub App verification does not expose the bot user's numeric id, so
    // retain an equivalent live-slot constraint on the provider-native name.
    uniqueIndex("chat_endpoints_live_bot_username_uq")
      .on(table.provider, table.providerAccountId, table.botUsername)
      .where(
        sql`${table.status} in ('verifying', 'active', 'paused', 'attention')
          and ${table.providerAccountId} is not null
          and ${table.botUsername} is not null`,
      ),
    unique("chat_endpoints_company_id_uq").on(table.companyId, table.id),
    foreignKey({
      columns: [table.companyId, table.connectionId],
      foreignColumns: [toolConnections.companyId, toolConnections.id],
      name: "chat_endpoints_company_connection_fk",
    }).onDelete("cascade"),
  ],
);
export const chatEndpointResources = pgTable(
  "chat_endpoint_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").notNull(),
    type: text("type").notNull(),
    providerResourceId: text("provider_resource_id").notNull(),
    parentProviderResourceId: text("parent_provider_resource_id"),
    label: text("label").notNull(),
    detail: text("detail"),
    providerUrl: text("provider_url"),
    availability: text("availability").$type<ChatResourceAvailability>().notNull().default("available"),
    enabled: boolean("enabled").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("chat_endpoint_resources_availability_check", sql`${table.availability} in ('available', 'unavailable', 'removed')`),
    index("chat_endpoint_resources_endpoint_idx").on(table.companyId, table.endpointId),
    uniqueIndex("chat_endpoint_resources_external_uq").on(table.endpointId, table.type, table.providerResourceId),
    unique("chat_endpoint_resources_company_id_uq").on(table.companyId, table.id),
    foreignKey({
      columns: [table.companyId, table.endpointId],
      foreignColumns: [chatEndpoints.companyId, chatEndpoints.id],
      name: "chat_endpoint_resources_company_endpoint_fk",
    }).onDelete("cascade"),
  ],
);

export const chatExternalPrincipals = pgTable(
  "chat_external_principals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").$type<ChatProvider>().notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    externalId: text("external_id").notNull(),
    kind: text("kind").$type<ChatPrincipalKind>().notNull().default("user"),
    displayName: text("display_name"),
    handle: text("handle"),
    avatarUrl: text("avatar_url"),
    isBot: boolean("is_bot").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("chat_external_principals_provider_check", sql`${table.provider} in ('slack', 'github', 'microsoft-teams', 'telegram')`),
    check("chat_external_principals_kind_check", sql`${table.kind} in ('user', 'bot', 'app', 'system')`),
    index("chat_external_principals_company_idx").on(table.companyId),
    uniqueIndex("chat_external_principals_external_uq").on(table.companyId, table.provider, table.providerAccountId, table.externalId),
    unique("chat_external_principals_company_id_uq").on(table.companyId, table.id),
  ],
);

export const chatIdentityLinks = pgTable(
  "chat_identity_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    paperclipUserId: text("paperclip_user_id"),
    status: text("status").$type<ChatIdentityLinkStatus>().notNull().default("pending"),
    confirmationTokenHash: text("confirmation_token_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("chat_identity_links_status_check", sql`${table.status} in ('pending', 'linked', 'revoked', 'expired')`),
    index("chat_identity_links_user_idx").on(table.companyId, table.paperclipUserId),
    uniqueIndex("chat_identity_links_endpoint_principal_uq").on(table.endpointId, table.principalId),
    foreignKey({ columns: [table.companyId, table.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id], name: "chat_identity_links_company_endpoint_fk" }).onDelete("cascade"),
    foreignKey({ columns: [table.companyId, table.principalId], foreignColumns: [chatExternalPrincipals.companyId, chatExternalPrincipals.id], name: "chat_identity_links_company_principal_fk" }).onDelete("cascade"),
  ],
);

export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").notNull(),
    resourceId: uuid("resource_id"),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "restrict" }),
    externalConversationId: text("external_conversation_id").notNull(),
    externalThreadId: text("external_thread_id").notNull().default(""),
    // Providers with linear conversations (DMs, Telegram groups, Teams group
    // chats) reuse one native thread id. A generation preserves the native id
    // used for replies while allowing completed Paperclip tasks to roll over.
    sessionGeneration: integer("session_generation").notNull().default(1),
    externalLabel: text("external_label").notNull(),
    providerUrl: text("provider_url"),
    isDirectMessage: boolean("is_direct_message").notNull().default(false),
    state: text("state").notNull().default("active"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("chat_conversations_state_check", sql`${table.state} in ('active', 'waiting', 'completed', 'unavailable', 'endpoint_removed')`),
    index("chat_conversations_issue_idx").on(table.companyId, table.issueId),
    uniqueIndex("chat_conversations_thread_uq").on(
      table.endpointId,
      table.externalConversationId,
      table.externalThreadId,
      table.sessionGeneration,
    ),
    unique("chat_conversations_company_id_uq").on(table.companyId, table.id),
    foreignKey({ columns: [table.companyId, table.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id], name: "chat_conversations_company_endpoint_fk" }).onDelete("cascade"),
    foreignKey({ columns: [table.companyId, table.resourceId], foreignColumns: [chatEndpointResources.companyId, chatEndpointResources.id], name: "chat_conversations_company_resource_fk" }).onDelete("set null"),
  ],
);

export const chatDeliveries = pgTable(
  "chat_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").notNull(),
    conversationId: uuid("conversation_id"),
    principalId: uuid("principal_id"),
    providerEventId: text("provider_event_id").notNull(),
    deduplicationKey: text("deduplication_key").notNull(),
    eventKind: text("event_kind").$type<ChatEventKind>().notNull(),
    normalizedEvent: jsonb("normalized_event").$type<Record<string, unknown>>().notNull(),
    state: text("state").$type<ChatDeliveryState>().notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    redactedError: text("redacted_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("chat_deliveries_state_check", sql`${table.state} in ('received', 'filtered', 'processing', 'processed', 'retry', 'failed')`),
    index("chat_deliveries_work_idx").on(table.state, table.nextAttemptAt),
    uniqueIndex("chat_deliveries_event_uq").on(table.endpointId, table.providerEventId),
    uniqueIndex("chat_deliveries_dedupe_uq").on(table.endpointId, table.deduplicationKey),
    foreignKey({ columns: [table.companyId, table.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id], name: "chat_deliveries_company_endpoint_fk" }).onDelete("cascade"),
    foreignKey({ columns: [table.companyId, table.conversationId], foreignColumns: [chatConversations.companyId, chatConversations.id], name: "chat_deliveries_company_conversation_fk" }).onDelete("set null"),
    foreignKey({ columns: [table.companyId, table.principalId], foreignColumns: [chatExternalPrincipals.companyId, chatExternalPrincipals.id], name: "chat_deliveries_company_principal_fk" }).onDelete("set null"),
  ],
);

export const chatPublications = pgTable(
  "chat_publications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "restrict" }),
    commentId: uuid("comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<SafeChatPublicationPayload>().notNull(),
    state: text("state").$type<ChatPublicationState>().notNull().default("pending"),
    providerMessageId: text("provider_message_id"),
    providerUrl: text("provider_url"),
    attempts: integer("attempts").notNull().default(0),
    redactedError: text("redacted_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("chat_publications_state_check", sql`${table.state} in ('pending', 'streaming', 'published', 'retry', 'delivery_unknown', 'failed', 'cancelled')`),
    index("chat_publications_work_idx").on(table.state, table.nextAttemptAt),
    uniqueIndex("chat_publications_idempotency_uq").on(table.companyId, table.idempotencyKey),
    foreignKey({ columns: [table.companyId, table.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id], name: "chat_publications_company_endpoint_fk" }).onDelete("cascade"),
    foreignKey({ columns: [table.companyId, table.conversationId], foreignColumns: [chatConversations.companyId, chatConversations.id], name: "chat_publications_company_conversation_fk" }).onDelete("cascade"),
  ],
);

export const chatMessageLinks = pgTable(
  "chat_message_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    deliveryId: uuid("delivery_id").references(() => chatDeliveries.id, { onDelete: "set null" }),
    publicationId: uuid("publication_id").references(() => chatPublications.id, { onDelete: "set null" }),
    commentId: uuid("comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    providerMessageId: text("provider_message_id").notNull(),
    direction: text("direction").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("chat_message_links_direction_check", sql`${table.direction} in ('inbound', 'outbound')`),
    uniqueIndex("chat_message_links_provider_message_uq").on(
      table.endpointId,
      table.conversationId,
      table.providerMessageId,
    ),
    foreignKey({ columns: [table.companyId, table.conversationId], foreignColumns: [chatConversations.companyId, chatConversations.id], name: "chat_message_links_company_conversation_fk" }).onDelete("cascade"),
  ],
);

export const chatActions = pgTable(
  "chat_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").notNull(),
    deliveryId: uuid("delivery_id").references(() => chatDeliveries.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id"),
    principalId: uuid("principal_id"),
    kind: text("kind").notNull(),
    providerActionId: text("provider_action_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("received"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chat_actions_provider_action_uq").on(table.endpointId, table.providerActionId),
    foreignKey({ columns: [table.companyId, table.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id], name: "chat_actions_company_endpoint_fk" }).onDelete("cascade"),
  ],
);

export const chatAgentRoutes = pgTable(
  "chat_agent_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceEndpointId: uuid("source_endpoint_id").notNull(),
    destinationEndpointId: uuid("destination_endpoint_id").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    triggerMode: text("trigger_mode").notNull().default("explicit_mention"),
    maxHops: integer("max_hops").notNull().default(1),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("chat_agent_routes_hops_check", sql`${table.maxHops} between 1 and 8`),
    uniqueIndex("chat_agent_routes_pair_uq").on(table.sourceEndpointId, table.destinationEndpointId),
    foreignKey({ columns: [table.companyId, table.sourceEndpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id], name: "chat_agent_routes_company_source_fk" }).onDelete("cascade"),
    foreignKey({ columns: [table.companyId, table.destinationEndpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id], name: "chat_agent_routes_company_destination_fk" }).onDelete("cascade"),
  ],
);

export const chatEndpointLeases = pgTable(
  "chat_endpoint_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").notNull(),
    leaseKey: text("lease_key").notNull(),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chat_endpoint_leases_active_uq").on(table.endpointId, table.leaseKey),
    index("chat_endpoint_leases_expiry_idx").on(table.expiresAt),
    foreignKey({ columns: [table.companyId, table.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id], name: "chat_endpoint_leases_company_endpoint_fk" }).onDelete("cascade"),
  ],
);

export const chatSdkState = pgTable(
  "chat_sdk_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").notNull(),
    stateKey: text("state_key").notNull(),
    version: integer("version").notNull().default(1),
    value: jsonb("value").$type<unknown>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chat_sdk_state_key_uq").on(table.endpointId, table.stateKey),
    index("chat_sdk_state_expiry_idx").on(table.expiresAt),
    foreignKey({ columns: [table.companyId, table.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id], name: "chat_sdk_state_company_endpoint_fk" }).onDelete("cascade"),
  ],
);

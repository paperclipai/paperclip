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

// Enums for MCP/API types
export const mcpServerTypeEnum = pgEnum("mcp_server_type", ["mcp", "external_api"]);

export const mcpProtocolEnum = pgEnum("mcp_protocol", ["stdio", "sse", "http"]);

export const healthStatusEnum = pgEnum("health_status", ["healthy", "unhealthy", "unknown"]);

export const authenticationTypeEnum = pgEnum("authentication_type", [
  "oauth",
  "api_key",
  "bearer_token",
  "basic",
]);

export const adapterTypeEnum = pgEnum("adapter_type", ["tool", "resource", "transformer"]);

export const testStatusEnum = pgEnum("test_status", ["success", "failed", "never_tested"]);

/**
 * MCP Server configurations
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: mcpServerTypeEnum("type").notNull(),
    protocol: mcpProtocolEnum("protocol"),
    command: text("command"),
    url: text("url"),
    environment: jsonb("environment").$type<Record<string, string>>(),
    configuration: jsonb("configuration").$type<Record<string, unknown>>().notNull(),
    enabled: boolean("enabled").default(true),
    errorMessage: text("error_message"),
    lastHealthCheck: timestamp("last_health_check", { withTimezone: true }),
    healthStatus: healthStatusEnum("health_status"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("mcp_servers_company_idx").on(table.companyId),
    typeIdx: index("mcp_servers_type_idx").on(table.type),
    enabledIdx: index("mcp_servers_enabled_idx").on(table.enabled),
  })
);

/**
 * External API Integrations
 */
export const externalApiIntegrations = pgTable(
  "external_api_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    apiEndpoint: text("api_endpoint").notNull(),
    authenticationType: authenticationTypeEnum("authentication_type").notNull(),
    credentials: jsonb("credentials").$type<Record<string, unknown>>().notNull(),
    scope: text("scope").array(),
    rateLimit: integer("rate_limit"),
    timeoutSeconds: integer("timeout_seconds").default(30),
    retryPolicy: jsonb("retry_policy").$type<Record<string, unknown>>(),
    enabled: boolean("enabled").default(true),
    errorMessage: text("error_message"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    testStatus: testStatusEnum("test_status"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("external_api_integrations_company_idx").on(table.companyId),
    providerIdx: index("external_api_integrations_provider_idx").on(table.provider),
  })
);

/**
 * API Request/Response logs
 */
export const apiRequestLogs = pgTable(
  "api_request_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => externalApiIntegrations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id),
    method: text("method").notNull(),
    endpoint: text("endpoint").notNull(),
    statusCode: integer("status_code"),
    requestBody: jsonb("request_body").$type<Record<string, unknown>>(),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    integrationIdx: index("api_request_logs_integration_idx").on(table.integrationId),
    agentIdx: index("api_request_logs_agent_idx").on(table.agentId),
    createdIdx: index("api_request_logs_created_idx").on(table.createdAt),
  })
);

/**
 * Custom Adapters
 */
export const customAdapters = pgTable(
  "custom_adapters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    adapterType: adapterTypeEnum("adapter_type").notNull(),
    sourceCode: text("source_code").notNull(),
    language: text("language").default("javascript"),
    isEnabled: boolean("is_enabled").default(true),
    version: text("version").notNull().default("1.0.0"),
    authorId: uuid("author_id").references(() => authUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("custom_adapters_company_idx").on(table.companyId),
    typeIdx: index("custom_adapters_type_idx").on(table.adapterType),
  })
);

/**
 * MCP Tools (exposed by MCP servers)
 */
export const mcpTools = pgTable(
  "mcp_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>(),
    outputSchema: jsonb("output_schema").$type<Record<string, unknown>>(),
    isEnabled: boolean("is_enabled").default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    serverIdx: index("mcp_tools_server_idx").on(table.serverId),
    uniqueTool: uniqueIndex("mcp_tools_unique").on(table.serverId, table.name),
  })
);

/**
 * MCP Resources
 */
export const mcpResources = pgTable(
  "mcp_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    uri: text("uri").notNull(),
    name: text("name"),
    description: text("description"),
    mimeType: text("mime_type"),
    content: text("content"), // Base64-encoded content
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    serverIdx: index("mcp_resources_server_idx").on(table.serverId),
    uniqueResource: uniqueIndex("mcp_resources_unique").on(table.serverId, table.uri),
  })
);

/**
 * Agent + MCP/API Associations
 */
export const agentApiAssociations = pgTable(
  "agent_api_associations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    mcpServerId: uuid("mcp_server_id").references(() => mcpServers.id, {
      onDelete: "set null",
    }),
    apiIntegrationId: uuid("api_integration_id").references(
      () => externalApiIntegrations.id,
      { onDelete: "set null" }
    ),
    enabled: boolean("enabled").default(true),
    configuration: jsonb("configuration").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentIdx: index("agent_api_associations_agent_idx").on(table.agentId),
    mcpIdx: index("agent_api_associations_mcp_idx").on(table.mcpServerId),
    apiIdx: index("agent_api_associations_api_idx").on(table.apiIntegrationId),
  })
);

/**
 * Webhook/Event subscriptions for external APIs
 */
export const apiEventSubscriptions = pgTable(
  "api_event_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => externalApiIntegrations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    webhookUrl: text("webhook_url"),
    webhookSecret: text("webhook_secret"),
    filter: jsonb("filter").$type<Record<string, unknown>>(),
    enabled: boolean("enabled").default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    integrationIdx: index("api_event_subscriptions_integration_idx").on(
      table.integrationId
    ),
    agentIdx: index("api_event_subscriptions_agent_idx").on(table.agentId),
  })
);

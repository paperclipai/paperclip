import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

/**
 * Agent OAuth connectors - stores OAuth connection state per agent.
 * This enables each agent to have its own set of connected services (Google, Slack, etc.)
 * without sharing credentials across agents.
 */
export const agentConnectors = pgTable(
  "agent_connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    connectorType: text("connector_type").notNull(),
    // The OAuth provider (google_workspace, slack, github, etc.)
    provider: text("provider").notNull(),
    // Display name for this connection (e.g., "My Google Account")
    displayName: text("display_name"),
    // OAuth state and token storage (encrypted at rest)
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    // OAuth scopes that were granted
    scopes: jsonb("scopes").$type<string[]>(),
    // Additional provider-specific data (user info, email, etc.)
    providerData: jsonb("provider_data"),
    // Connection status
    status: text("status")
      .notNull()
      .default("pending"),
    // Error message if connection failed
    errorMessage: text("error_message"),
    // Timestamps
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdIdx: index("agent_connectors_agent_id_idx").on(table.agentId),
    providerIdx: index("agent_connectors_provider_idx").on(table.provider),
  }),
);

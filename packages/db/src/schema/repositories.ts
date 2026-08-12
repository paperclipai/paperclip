import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const repositoryConnections = pgTable(
  "repository_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    provider: text("provider").notNull(),
    host: text("host").notNull(),
    installationId: text("installation_id"),
    accountId: text("account_id"),
    accountName: text("account_name"),
    status: text("status").notNull().default("active"),
    syncStatus: text("sync_status").notNull().default("idle"),
    syncCursor: text("sync_cursor"),
    syncError: text("sync_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    providerMetadata: jsonb("provider_metadata").$type<Record<string, unknown>>(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("repository_connections_company_idx").on(table.companyId),
    providerHostIdx: index("repository_connections_company_provider_host_idx").on(
      table.companyId,
      table.provider,
      table.host,
    ),
    installationIdx: uniqueIndex("repository_connections_company_installation_idx")
      .on(table.companyId, table.provider, table.host, table.installationId)
      .where(sql`${table.installationId} is not null`),
  }),
);

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    connectionId: uuid("connection_id").references(() => repositoryConnections.id, { onDelete: "set null" }),
    provider: text("provider").notNull().default("manual"),
    providerRepositoryId: text("provider_repository_id"),
    identityKey: text("identity_key").notNull(),
    host: text("host").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    cloneUrl: text("clone_url").notNull(),
    webUrl: text("web_url"),
    defaultBranch: text("default_branch"),
    visibility: text("visibility").notNull().default("unknown"),
    state: text("state").notNull().default("active"),
    unavailableReason: text("unavailable_reason"),
    providerMetadata: jsonb("provider_metadata").$type<Record<string, unknown>>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStateIdx: index("repositories_company_state_idx").on(table.companyId, table.state),
    companyConnectionIdx: index("repositories_company_connection_idx").on(table.companyId, table.connectionId),
    identityIdx: uniqueIndex("repositories_company_identity_idx").on(table.companyId, table.identityKey),
    providerRepositoryIdx: uniqueIndex("repositories_company_provider_repository_idx")
      .on(table.companyId, table.provider, table.host, table.providerRepositoryId)
      .where(sql`${table.providerRepositoryId} is not null`),
  }),
);

export const projectRepositories = pgTable(
  "project_repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
    displayOrder: integer("display_order").notNull().default(0),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("project_repositories_company_project_idx").on(table.companyId, table.projectId),
    companyRepositoryIdx: index("project_repositories_company_repository_idx").on(
      table.companyId,
      table.repositoryId,
    ),
    relationshipIdx: uniqueIndex("project_repositories_company_relationship_idx").on(
      table.companyId,
      table.projectId,
      table.repositoryId,
    ),
  }),
);

export const agentRepositoryGrants = pgTable(
  "agent_repository_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
    grantedByAgentId: uuid("granted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    grantedByUserId: text("granted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("agent_repository_grants_company_agent_idx").on(table.companyId, table.agentId),
    companyRepositoryIdx: index("agent_repository_grants_company_repository_idx").on(
      table.companyId,
      table.repositoryId,
    ),
    relationshipIdx: uniqueIndex("agent_repository_grants_company_relationship_idx").on(
      table.companyId,
      table.agentId,
      table.repositoryId,
    ),
  }),
);

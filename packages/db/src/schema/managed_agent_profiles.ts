import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

/**
 * Company-scoped, non-secret snapshots of qualified Claude Managed Agent
 * resources. Credentials remain in the company secret store and are linked by
 * id only. Runtime inputs copy the immutable public resource identity from this
 * row rather than accepting it from an agent's editable adapter config.
 */
export const managedAgentProfiles = pgTable(
  "managed_agent_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    profileKey: text("profile_key").notNull(),
    displayName: text("display_name").notNull(),
    service: text("service").notNull().default("anthropic_managed_agents"),
    anthropicAgentId: text("anthropic_agent_id").notNull(),
    agentVersion: text("agent_version").notNull(),
    environmentId: text("environment_id").notNull(),
    betaVersion: text("beta_version").notNull().default("managed-agents-2026-04-01"),
    defaultModel: text("default_model").notNull().default("claude-sonnet-5"),
    defaultMaxListCostCents: integer("default_max_list_cost_cents").notNull().default(100),
    apiKeySecretId: uuid("api_key_secret_id")
      .notNull()
      .references(() => companySecrets.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull().default(false),
    retentionAcknowledged: boolean("retention_acknowledged").notNull().default(false),
    qualification: jsonb("qualification").$type<Record<string, unknown>>().notNull().default({}),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    qualifiedRevision: text("qualified_revision"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("managed_agent_profiles_company_idx").on(table.companyId),
    companyKeyUq: uniqueIndex("managed_agent_profiles_company_key_uq").on(
      table.companyId,
      table.profileKey,
    ),
    resourceUq: uniqueIndex("managed_agent_profiles_company_resource_uq").on(
      table.companyId,
      table.anthropicAgentId,
      table.agentVersion,
      table.environmentId,
    ),
    serviceCheck: check(
      "managed_agent_profiles_service_check",
      sql`${table.service} = 'anthropic_managed_agents'`,
    ),
    betaCheck: check(
      "managed_agent_profiles_beta_check",
      sql`${table.betaVersion} = 'managed-agents-2026-04-01'`,
    ),
    positiveBudgetCheck: check(
      "managed_agent_profiles_positive_budget_check",
      sql`${table.defaultMaxListCostCents} > 0`,
    ),
    qualifiedRevisionCheck: check(
      "managed_agent_profiles_qualified_revision_check",
      sql`(${table.qualifiedAt} IS NULL AND ${table.qualifiedRevision} IS NULL) OR (${table.qualifiedAt} IS NOT NULL AND ${table.qualification} <> '{}'::jsonb AND ${table.qualifiedRevision} ~ '^sha256:[0-9a-f]{64}$')`,
    ),
  }),
);

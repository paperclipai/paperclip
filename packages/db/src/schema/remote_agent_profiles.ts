import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { companies } from "./companies.js";

/**
 * Company-scoped, non-secret snapshots of qualified remote runner resources.
 * AWS AgentCore authentication uses the runner environment's workload identity;
 * the profile stores no credential reference or credential material.
 */
export const remoteAgentProfiles = pgTable(
  "remote_agent_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    profileKey: text("profile_key").notNull(),
    displayName: text("display_name").notNull(),
    service: text("service").notNull(),
    configuration: jsonb("configuration").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(false),
    retentionAcknowledged: boolean("retention_acknowledged").notNull().default(false),
    qualification: jsonb("qualification").$type<Record<string, unknown>>().notNull().default({}),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    qualifiedRevision: text("qualified_revision"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("remote_agent_profiles_company_idx").on(table.companyId),
    companyKeyUq: uniqueIndex("remote_agent_profiles_company_key_uq").on(
      table.companyId,
      table.profileKey,
    ),
    serviceCheck: check(
      "remote_agent_profiles_service_check",
      sql`${table.service} = 'aws_bedrock_agentcore_harness'`,
    ),
    qualifiedRevisionCheck: check(
      "remote_agent_profiles_qualified_revision_check",
      sql`(${table.qualifiedAt} IS NULL AND ${table.qualifiedRevision} IS NULL) OR (${table.qualifiedAt} IS NOT NULL AND ${table.qualification} <> '{}'::jsonb AND ${table.qualifiedRevision} ~ '^sha256:[0-9a-f]{64}$')`,
    ),
  }),
);

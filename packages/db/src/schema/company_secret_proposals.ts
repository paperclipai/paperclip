import { sql } from "drizzle-orm";
import { type AnyPgColumn, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const companySecretProposals = pgTable(
  "company_secret_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    proposedName: text("proposed_name"),
    proposedKey: text("proposed_key"),
    proposedDescription: text("proposed_description"),
    justification: text("justification").notNull(),
    valueCiphertext: jsonb("value_ciphertext").$type<Record<string, unknown> | null>(),
    valueFingerprintSha256: text("value_fingerprint_sha256"),
    valueLength: integer("value_length"),
    secretId: uuid("secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    secretProposalId: uuid("secret_proposal_id").references((): AnyPgColumn => companySecretProposals.id, { onDelete: "cascade" }),
    targetType: text("target_type"),
    targetId: uuid("target_id").references(() => agents.id, { onDelete: "cascade" }),
    configPath: text("config_path"),
    projectionClass: text("projection_class").notNull().default("unclassified"),
    bindingTargetPolicySnapshot: text("binding_target_policy_snapshot"),
    proposerAncestorIdsSnapshot: jsonb("proposer_ancestor_ids_snapshot").$type<string[] | null>(),
    targetAncestorIdsSnapshot: jsonb("target_ancestor_ids_snapshot").$type<string[] | null>(),
    proposedByAgentId: uuid("proposed_by_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    originIssueId: uuid("origin_issue_id").references(() => issues.id, { onDelete: "set null" }),
    originRunId: uuid("origin_run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionReason: text("resolution_reason"),
    createdSecretId: uuid("created_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    appliedBindingConfigPath: text("applied_binding_config_path"),
    ciphertextScrubbedAt: timestamp("ciphertext_scrubbed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("company_secret_proposals_company_status_idx").on(table.companyId, table.status),
    proposerStatusIdx: index("company_secret_proposals_proposer_status_idx").on(table.proposedByAgentId, table.status),
    expiryIdx: index("company_secret_proposals_expiry_idx").on(table.status, table.expiresAt),
    secretProposalIdx: index("company_secret_proposals_secret_proposal_idx").on(table.secretProposalId),
    kindCheck: check("company_secret_proposals_kind_check", sql`${table.kind} in ('secret', 'binding')`),
    statusCheck: check("company_secret_proposals_status_check", sql`${table.status} in ('pending', 'approved', 'rejected', 'withdrawn', 'expired')`),
    projectionCheck: check("company_secret_proposals_projection_check", sql`${table.projectionClass} = 'unclassified'`),
    shapeCheck: check("company_secret_proposals_shape_check", sql`(
      ${table.kind} = 'secret'
      and ${table.proposedName} is not null
      and ${table.proposedKey} is not null
      and ${table.secretId} is null
      and ${table.secretProposalId} is null
      and ${table.targetType} is null
      and ${table.targetId} is null
      and ${table.configPath} is null
    ) or (
      ${table.kind} = 'binding'
      and ((${table.secretId} is not null)::int + (${table.secretProposalId} is not null)::int) = 1
      and ${table.targetType} = 'agent'
      and ${table.targetId} is not null
      and ${table.configPath} is not null
    )`),
  }),
);

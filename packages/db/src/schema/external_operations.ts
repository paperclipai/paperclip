import { sql } from "drizzle-orm";
import { check, type AnyPgColumn, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const externalOperations = pgTable(
  "external_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    provider: text("provider").notNull(),
    stage: text("stage").notNull(),
    externalId: text("external_id").notNull(),
    supersedesOperationId: uuid("supersedes_operation_id")
      .references((): AnyPgColumn => externalOperations.id, { onDelete: "cascade" }),
    candidateSha: text("candidate_sha"),
    environment: text("environment"),
    url: text("url"),
    state: text("state").notNull().default("unknown"),
    verificationStatus: text("verification_status").notNull().default("unverified"),
    credentialSecretId: uuid("credential_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    timeoutAt: timestamp("timeout_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastVerificationError: text("last_verification_error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    kindCheck: check(
      "external_operations_kind_check",
      sql`${table.kind} in ('github_actions_workflow_run', 'cloudflare_pages_deployment', 'custom')`,
    ),
    stageCheck: check(
      "external_operations_stage_check",
      sql`${table.stage} in ('implementation', 'ci', 'deployment', 'smoke', 'functional_qa', 'technical_acceptance', 'business_acceptance')`,
    ),
    stateCheck: check(
      "external_operations_state_check",
      sql`${table.state} in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'unknown')`,
    ),
    verificationCheck: check(
      "external_operations_verification_check",
      sql`${table.verificationStatus} in ('unverified', 'verified', 'mismatch', 'error')`,
    ),
    issueUpdatedIdx: index("external_operations_company_issue_updated_idx").on(
      table.companyId,
      table.issueId,
      table.updatedAt,
    ),
    dueIdx: index("external_operations_verification_due_idx").on(
      table.verificationStatus,
      table.nextCheckAt,
    ),
    activeDueIdx: index("external_operations_active_due_idx")
      .on(table.nextCheckAt)
      .where(sql`${table.terminalAt} is null and ${table.nextCheckAt} is not null and ${table.state} not in ('succeeded', 'failed', 'cancelled', 'timed_out')`),
    issueProviderExternalUq: uniqueIndex("external_operations_issue_provider_external_uq").on(
      table.companyId,
      table.issueId,
      table.provider,
      table.kind,
      table.externalId,
    ),
    supersedesOnceUq: uniqueIndex("external_operations_supersedes_once_uq")
      .on(table.supersedesOperationId)
      .where(sql`${table.supersedesOperationId} is not null`),
  }),
);

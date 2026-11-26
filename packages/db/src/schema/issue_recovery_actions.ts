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
import { issues } from "./issues.js";

export const issueRecoveryActions = pgTable(
  "issue_recovery_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    recoveryIssueId: uuid("recovery_issue_id").references(() => issues.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("active"),
    ownerType: text("owner_type").notNull().default("agent"),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ownerUserId: text("owner_user_id"),
    previousOwnerAgentId: uuid("previous_owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    returnOwnerAgentId: uuid("return_owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    cause: text("cause").notNull(),
    fingerprint: text("fingerprint").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    nextAction: text("next_action").notNull(),
    wakePolicy: jsonb("wake_policy").$type<Record<string, unknown>>(),
    monitorPolicy: jsonb("monitor_policy").$type<Record<string, unknown>>(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts"),
    timeoutAt: timestamp("timeout_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    outcome: text("outcome"),
    resolutionNote: text("resolution_note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceRunIdx: index("issue_recovery_actions_source_run_idx")
      .on(table.companyId, table.sourceIssueId, sql`(${table.evidence}->>'runId')`),
    systemRecoveryDueIdx: index("issue_recovery_actions_system_recovery_due_idx")
      .on(sql`(${table.evidence}#>'{systemRecovery,nextAttemptAt}')`, table.id)
      .where(sql`${table.evidence} ? 'systemRecovery'`),
    systemRecoveryAdoptionIdx: index("issue_recovery_actions_system_recovery_adoption_idx")
      .on(table.id)
      .where(sql`not (${table.evidence} ? 'systemRecovery') and (
        ${table.evidence}->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'
        or ${table.cause} in ('native_workspace_sync_out_unrecoverable', 'native_workspace_sync_out_retry_exhausted')
      )`),
    retainedWorkspaceRecoveryIdx: index("issue_recovery_actions_retained_workspace_recovery_idx").on(table.id).where(sql`
      (${table.evidence}->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'
        or ${table.cause} in ('native_workspace_sync_out_unrecoverable', 'native_workspace_sync_out_retry_exhausted'))
      and (${table.evidence}->'executionReconciliation' is null
        or ${table.evidence}#>>'{workspaceRecovery,status}' = 'recovered')
    `),
    companySourceStatusIdx: index("issue_recovery_actions_company_source_status_idx").on(
      table.companyId,
      table.sourceIssueId,
      table.status,
    ),
    companyOwnerStatusIdx: index("issue_recovery_actions_company_owner_status_idx").on(
      table.companyId,
      table.ownerAgentId,
      table.status,
    ),
    companyRecoveryIssueIdx: index("issue_recovery_actions_company_recovery_issue_idx").on(
      table.companyId,
      table.recoveryIssueId,
    ),
    activeSourceIdx: uniqueIndex("issue_recovery_actions_active_source_uq")
      .on(table.companyId, table.sourceIssueId)
      .where(sql`${table.status} in ('active', 'escalated')`),
    activeFingerprintIdx: uniqueIndex("issue_recovery_actions_active_fingerprint_uq")
      .on(table.companyId, table.sourceIssueId, table.cause, table.fingerprint)
      .where(sql`${table.status} in ('active', 'escalated')`),
  }),
);

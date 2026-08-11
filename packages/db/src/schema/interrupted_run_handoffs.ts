import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueRecoveryActions } from "./issue_recovery_actions.js";
import { issues } from "./issues.js";

export const interruptedRunHandoffs = pgTable(
  "interrupted_run_handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull(),
    interruptedRunId: uuid("interrupted_run_id").notNull(),
    kind: text("kind").notNull().default("process_loss_handoff"),
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    successorRunId: uuid("successor_run_id"),
    recoveryActionId: uuid("recovery_action_id").references(() => issueRecoveryActions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    fingerprintIdx: uniqueIndex("interrupted_run_handoffs_fingerprint_uq").on(
      table.companyId,
      table.issueId,
      table.interruptedRunId,
      table.kind,
    ),
    companyIssueStatusIdx: index("interrupted_run_handoffs_company_issue_status_idx").on(
      table.companyId,
      table.issueId,
      table.status,
    ),
    companySuccessorIdx: index("interrupted_run_handoffs_company_successor_idx").on(
      table.companyId,
      table.successorRunId,
    ),
    issueCompanyFk: foreignKey({
      name: "interrupted_run_handoffs_issue_company_fk",
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
    }).onDelete("cascade"),
    interruptedRunCompanyFk: foreignKey({
      name: "interrupted_run_handoffs_source_company_fk",
      columns: [table.companyId, table.interruptedRunId],
      foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id],
    }).onDelete("cascade"),
    successorRunCompanyFk: foreignKey({
      name: "interrupted_run_handoffs_successor_company_fk",
      columns: [table.companyId, table.successorRunId],
      foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id],
    }).onDelete("set null"),
    kindCheck: check(
      "interrupted_run_handoffs_kind_check",
      sql`${table.kind} = 'process_loss_handoff'`,
    ),
    statusCheck: check(
      "interrupted_run_handoffs_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'waiting', 'terminal', 'suppressed', 'escalated')`,
    ),
    reasonLengthCheck: check(
      "interrupted_run_handoffs_reason_length_check",
      sql`char_length(${table.reason}) between 1 and 120`,
    ),
  }),
);

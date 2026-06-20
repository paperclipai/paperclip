import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const issueWatchdogs = pgTable(
  "issue_watchdogs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    watchdogAgentId: uuid("watchdog_agent_id").notNull().references(() => agents.id),
    instructions: text("instructions"),
    status: text("status").notNull().default("active"),
    watchdogIssueId: uuid("watchdog_issue_id").references(() => issues.id, { onDelete: "set null" }),
    lastObservedFingerprint: text("last_observed_fingerprint"),
    lastReviewedFingerprint: text("last_reviewed_fingerprint"),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
    triggerCount: integer("trigger_count").notNull().default(0),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    updatedByRunId: uuid("updated_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: uniqueIndex("issue_watchdogs_company_issue_uq").on(table.companyId, table.issueId),
    companyStatusIdx: index("issue_watchdogs_company_status_idx").on(table.companyId, table.status),
    companyAgentIdx: index("issue_watchdogs_company_agent_idx").on(table.companyId, table.watchdogAgentId),
    companyWatchdogIssueIdx: uniqueIndex("issue_watchdogs_company_watchdog_issue_uq")
      .on(table.companyId, table.watchdogIssueId)
      .where(sql`${table.watchdogIssueId} is not null`),
  }),
);

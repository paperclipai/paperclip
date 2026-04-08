import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { agentApiKeys } from "./agent_api_keys.js";
import { agentSessions } from "./agent_sessions.js";

/**
 * Phase 4: the runtime intent + history for a leader agent's Claude CLI.
 *
 * DB holds what SHOULD be running (intent + history). PM2 holds what IS
 * running. leaderProcessService reconciles the two on every status call
 * and at server startup.
 *
 * UNIQUE (agent_id) — at most one row per agent. Restart reuses the row
 * via status transitions rather than insert/delete.
 *
 * @see docs/cos-v2/phase4-cli-design.md §9.1
 */
export const leaderProcesses = pgTable(
  "leader_processes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    /** stopped | starting | running | stopping | crashed */
    status: text("status").notNull(),
    /** unique PM2 process name (e.g. cos-cyrus-43ff837d) */
    pm2Name: text("pm2_name"),
    /** PM2 internal id from pm2.describe */
    pm2PmId: integer("pm2_pm_id"),
    pid: integer("pid"),
    agentKeyId: uuid("agent_key_id").references(() => agentApiKeys.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    exitCode: integer("exit_code"),
    exitReason: text("exit_reason"),
    /** Provision / spawn / crash diagnostic surfaced in the UI */
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("leader_processes_company_idx").on(table.companyId),
    statusIdx: index("leader_processes_status_idx").on(table.status),
    agentUnique: uniqueIndex("leader_processes_agent_unique").on(table.agentId),
  }),
);

export type LeaderProcessRow = typeof leaderProcesses.$inferSelect;
export type LeaderProcessInsert = typeof leaderProcesses.$inferInsert;

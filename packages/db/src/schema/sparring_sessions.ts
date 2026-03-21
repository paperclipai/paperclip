import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export interface SparringSessionConfig {
  maxRounds?: number;
  totalTimeoutSec?: number;
  turnTimeoutSec?: number;
}

export const sparringSessions = pgTable(
  "sparring_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    coordinatorAgentId: uuid("coordinator_agent_id").notNull().references(() => agents.id),
    topic: text("topic").notNull(),
    status: text("status").notNull().default("active"),
    config: jsonb("config").$type<SparringSessionConfig>(),
    summary: text("summary"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    companyIdx: index("sparring_sessions_company_idx").on(table.companyId),
    issueIdx: index("sparring_sessions_issue_idx").on(table.issueId),
    activeIssueUnique: uniqueIndex("sparring_sessions_active_issue_unique")
      .on(table.issueId)
      .where(sql`status = 'active'`),
  }),
);

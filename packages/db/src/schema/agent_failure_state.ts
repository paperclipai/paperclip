import { pgTable, uuid, integer, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const agentFailureState = pgTable("agent_failure_state", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  consecutiveAdapterFailures: integer("consecutive_adapter_failures").notNull().default(0),
  consecutiveSuccesses: integer("consecutive_successes").notNull().default(0),
  firstFailureRunId: uuid("first_failure_run_id").references(() => heartbeatRuns.id),
  lastFailureRunId: uuid("last_failure_run_id").references(() => heartbeatRuns.id),
  openAutoIssueId: uuid("open_auto_issue_id").references(() => issues.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

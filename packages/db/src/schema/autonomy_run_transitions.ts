import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const autonomyRunTransitions = pgTable(
  "autonomy_run_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    laneKey: text("lane_key"),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    terminalClassification: text("terminal_classification"),
    reason: text("reason"),
    actorType: text("actor_type").notNull().default("kernel"),
    actorId: text("actor_id"),
    evidenceEntryIds: jsonb("evidence_entry_ids").$type<string[]>().notNull().default([]),
    incidentIds: jsonb("incident_ids").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    transitionedAt: timestamp("transitioned_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRunIdx: index("autonomy_run_transitions_company_run_idx").on(table.companyId, table.runId),
    companyIssueIdx: index("autonomy_run_transitions_company_issue_idx").on(table.companyId, table.issueId),
    companyAgentIdx: index("autonomy_run_transitions_company_agent_idx").on(table.companyId, table.agentId),
    companyToStateIdx: index("autonomy_run_transitions_company_to_state_idx").on(table.companyId, table.toState),
    companyTerminalIdx: index("autonomy_run_transitions_company_terminal_idx").on(
      table.companyId,
      table.terminalClassification,
    ),
    companyLaneTransitionedIdx: index("autonomy_run_transitions_company_lane_transitioned_idx").on(
      table.companyId,
      table.laneKey,
      table.transitionedAt,
    ),
  }),
);

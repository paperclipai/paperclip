import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const agentTaskSessions = pgTable(
  "agent_task_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    adapterType: text("adapter_type").notNull(),
    taskKey: text("task_key").notNull(),
    sessionParamsJson: jsonb("session_params_json").$type<Record<string, unknown>>(),
    sessionDisplayId: text("session_display_id"),
    lastRunId: uuid("last_run_id").references(() => heartbeatRuns.id),
    lastError: text("last_error"),
    goalCapabilityJson: jsonb("goal_capability_json").$type<Record<string, unknown>>(),
    goalJson: jsonb("goal_json").$type<Record<string, unknown>>(),
    goalStatus: text("goal_status"),
    goalDesiredState: text("goal_desired_state"),
    goalSourceId: text("goal_source_id"),
    goalSourceCursor: bigint("goal_source_cursor", { mode: "number" }),
    goalRevision: integer("goal_revision").notNull().default(0),
    goalObservedAt: timestamp("goal_observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentTaskUniqueIdx: uniqueIndex("agent_task_sessions_company_agent_adapter_task_uniq").on(
      table.companyId,
      table.agentId,
      table.adapterType,
      table.taskKey,
    ),
    companyAgentUpdatedIdx: index("agent_task_sessions_company_agent_updated_idx").on(
      table.companyId,
      table.agentId,
      table.updatedAt,
    ),
    companyTaskUpdatedIdx: index("agent_task_sessions_company_task_updated_idx").on(
      table.companyId,
      table.taskKey,
      table.updatedAt,
    ),
  }),
);

export const agentSessionGoalActions = pgTable(
  "agent_session_goal_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentTaskSessions.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    action: text("action").notNull(),
    payloadJson: jsonb("payload_json").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionRequestUniqueIdx: uniqueIndex("agent_session_goal_actions_session_request_uniq").on(
      table.sessionId,
      table.requestId,
    ),
    companyStatusCreatedIdx: index("agent_session_goal_actions_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    sessionCreatedIdx: index("agent_session_goal_actions_session_created_idx").on(
      table.sessionId,
      table.createdAt,
    ),
  }),
);

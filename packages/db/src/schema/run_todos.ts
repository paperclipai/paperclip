import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const RUN_TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type RunTodoStatus = (typeof RUN_TODO_STATUSES)[number];

export const runTodos = pgTable(
  "run_todos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => heartbeatRuns.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    issueId: uuid("issue_id").references(() => issues.id),
    label: text("label").notNull(),
    status: text("status").notNull().default("pending").$type<RunTodoStatus>(),
    seq: integer("seq").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSeqIdx: index("run_todos_run_seq_idx").on(table.runId, table.seq),
    issueIdx: index("run_todos_issue_idx").on(table.issueId),
  }),
);

import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { workflowRuns } from "./workflow_runs.js";

export const workflowRunSteps = pgTable(
  "workflow_run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    stepType: text("step_type").notNull(),
    status: text("status").notNull().default("pending"),
    input: jsonb("input").$type<Record<string, unknown>>(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdIdx: index("workflow_run_steps_run_id_idx").on(table.runId),
    runStatusIdx: index("workflow_run_steps_run_status_idx").on(table.runId, table.status),
  }),
);

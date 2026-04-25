import { index, integer, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { modelBenchmarkRuns } from "./model_benchmark_runs.js";

export const modelEvaluations = pgTable(
  "model_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: text("role").notNull(),
    model: text("model").notNull(),
    harness: text("harness").notNull(),
    subscription: text("subscription").notNull(),
    benchmarkType: text("benchmark_type").$type<"internal_pr" | "public_benchmark">().notNull(),
    benchmarkRunId: uuid("benchmark_run_id").references(() => modelBenchmarkRuns.id),
    taskIdentifier: text("task_identifier").notNull(),
    taskOutcome: text("task_outcome").$type<"success" | "failure" | "partial">().notNull(),
    qualityScore: real("quality_score"),
    tokenCost: integer("token_cost"),
    latencyMs: integer("latency_ms"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roleIdx: index("model_evaluations_role_idx").on(table.role),
    modelIdx: index("model_evaluations_model_idx").on(table.model),
    benchmarkRunIdIdx: index("model_evaluations_benchmark_run_id_idx").on(table.benchmarkRunId),
    benchmarkTypeIdx: index("model_evaluations_benchmark_type_idx").on(table.benchmarkType),
    taskOutcomeIdx: index("model_evaluations_task_outcome_idx").on(table.taskOutcome),
    evaluatedAtIdx: index("model_evaluations_evaluated_at_idx").on(table.evaluatedAt),
  }),
);

export type ModelEvaluation = typeof modelEvaluations.$inferSelect;
export type NewModelEvaluation = typeof modelEvaluations.$inferInsert;
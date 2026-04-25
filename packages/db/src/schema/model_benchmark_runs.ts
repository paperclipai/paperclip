import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const modelBenchmarkRuns = pgTable(
  "model_benchmark_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    benchmarkType: text("benchmark_type").notNull(),
    description: text("description"),
    status: text("status").$type<"running" | "completed" | "failed">().notNull().default("running"),
    totalTasks: integer("total_tasks").notNull().default(0),
    completedTasks: integer("completed_tasks").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    benchmarkTypeIdx: index("model_benchmark_runs_benchmark_type_idx").on(table.benchmarkType),
    statusIdx: index("model_benchmark_runs_status_idx").on(table.status),
    startedAtIdx: index("model_benchmark_runs_started_at_idx").on(table.startedAt),
  }),
);

export type ModelBenchmarkRun = typeof modelBenchmarkRuns.$inferSelect;
export type NewModelBenchmarkRun = typeof modelBenchmarkRuns.$inferInsert;
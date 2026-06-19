import {
  pgTable,
  text,
  integer,
  doublePrecision,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";

// Mirrors outcome_weights in
// services/oracle-dispatcher/migrations/0001_learning.sql (authoritative).
// Numeric rollups per (task_class, agent, route_tier).
// NPI BAN: IDs + numbers ONLY. No borrower content of any kind.
// Natural composite key; ingestion UPSERTs.
export const outcomeWeights = pgTable(
  "outcome_weights",
  {
    taskClass: text("task_class").notNull(),
    agent: text("agent").notNull(),
    routeTier: text("route_tier").notNull(),
    nRuns: integer("n_runs").notNull().default(0),
    successRate: doublePrecision("success_rate").notNull().default(0.0),
    avgLatencyMs: doublePrecision("avg_latency_ms").notNull().default(0.0),
    loanConversionRate: doublePrecision("loan_conversion_rate").notNull().default(0.0),
    userFbScore: doublePrecision("user_fb_score").notNull().default(0.0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.taskClass, table.agent, table.routeTier],
      name: "outcome_weights_pkey",
    }),
  }),
);

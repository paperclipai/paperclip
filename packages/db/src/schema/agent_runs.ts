import { sql } from "drizzle-orm";
import {
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { promptVersions } from "./prompt_versions.js";

// Mirrors agent_runs in
// services/oracle-dispatcher/migrations/0001_learning.sql (authoritative).
// One row per dispatched job; terminal signals join back by id.
// input_hash / output_hash are HASHES (NPI never stored raw).
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    agent: text("agent").notNull(),
    taskClass: text("task_class").notNull(),
    promptVersionId: bigint("prompt_version_id", { mode: "number" }).references(
      () => promptVersions.id,
    ),
    inputHash: text("input_hash"),
    outputHash: text("output_hash"),
    outcome: text("outcome"),
    userFeedback: integer("user_feedback"),
    latencyMs: integer("latency_ms"),
    tier: text("tier"),
    // Stable link back to the heartbeat_runs row that produced this telemetry
    // (set by the PR2 emitter). Nullable: dispatcher-originated rows have none.
    heartbeatRunId: text("heartbeat_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    classOutcomeIdx: index("ix_agent_runs_class_outcome").on(table.taskClass, table.outcome),
    promptVersionIdx: index("ix_agent_runs_prompt_version").on(table.promptVersionId),
    // Partial unique: at most one agent_runs row per heartbeat run (idempotent
    // emit), while leaving non-heartbeat rows (heartbeat_run_id IS NULL) free.
    heartbeatRunIdx: uniqueIndex("uq_agent_runs_heartbeat_run")
      .on(table.heartbeatRunId)
      .where(sql`${table.heartbeatRunId} IS NOT NULL`),
  }),
);

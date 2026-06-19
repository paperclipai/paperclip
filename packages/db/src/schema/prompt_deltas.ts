import { sql } from "drizzle-orm";
import {
  pgTable,
  bigserial,
  bigint,
  text,
  timestamp,
  check,
  index,
} from "drizzle-orm/pg-core";
import { promptVersions } from "./prompt_versions.js";

// Mirrors prompt_deltas in
// services/oracle-dispatcher/migrations/0001_learning.sql (authoritative).
// Refinement-loop PROPOSALS only. A delta becomes a candidate prompt_version
// ONLY after Gemini audit AND human approval (Model Role Protocol gate).
export const promptDeltas = pgTable(
  "prompt_deltas",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    baseVersion: bigint("base_version", { mode: "number" })
      .notNull()
      .references(() => promptVersions.id),
    proposedBody: text("proposed_body").notNull(),
    rationale: text("rationale").notNull(),
    // cited agent_runs.id
    sampleRunIds: bigint("sample_run_ids", { mode: "number" })
      .array()
      .notNull()
      .default(sql`'{}'`),
    geminiAudit: text("gemini_audit"),
    status: text("status").notNull().default("proposed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      "prompt_deltas_status_check",
      sql`${table.status} IN ('proposed', 'approved', 'rejected')`,
    ),
    baseStatusIdx: index("ix_prompt_deltas_base_status").on(table.baseVersion, table.status),
  }),
);

import { pgTable, uuid, text, timestamp, bigserial, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// DB-backed run-log transcript chunks. The Railway worker writes the run's output here as it
// streams; the Vercel control plane reads it back for the transcript view. This bridges the
// Vercel/Railway filesystem split that made the old local-file run logs unreadable from the UI
// ("Run log not found"). `seq` is a global bigserial so chunks order by insertion with no
// in-memory cursor (race-free across worker restarts / resumed runs).
export const heartbeatRunLogChunks = pgTable(
  "heartbeat_run_log_chunks",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    stream: text("stream").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSeqIdx: index("heartbeat_run_log_chunks_run_seq_idx").on(table.runId, table.seq),
  }),
);

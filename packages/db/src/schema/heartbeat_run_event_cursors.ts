import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/** Derived from retained run events; never an independent replay authority. */
export const heartbeatRunEventCursors = pgTable("heartbeat_run_event_cursors", {
  companyId: uuid("company_id").notNull().references(() => companies.id),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  sourceInstanceId: text("source_instance_id").notNull(),
  contiguousSourceSeq: bigint("contiguous_source_seq", { mode: "number" }).notNull().default(0),
  pendingRangeCount: integer("pending_range_count").notNull().default(0),
}, table => ({
  pk: primaryKey({ columns: [table.companyId, table.runId, table.sourceInstanceId] }),
  nonnegative: check("heartbeat_run_event_cursors_nonnegative", sql`${table.contiguousSourceSeq} >= 0 and ${table.pendingRangeCount} >= 0`),
}));

/** Nonadjacent received ranges strictly above the contiguous source prefix. */
export const heartbeatRunEventSourceRanges = pgTable("heartbeat_run_event_source_ranges", {
  companyId: uuid("company_id").notNull(),
  runId: uuid("run_id").notNull(),
  sourceInstanceId: text("source_instance_id").notNull(),
  startSeq: bigint("start_seq", { mode: "number" }).notNull(),
  endSeq: bigint("end_seq", { mode: "number" }).notNull(),
}, table => ({
  pk: primaryKey({ columns: [table.companyId, table.runId, table.sourceInstanceId, table.startSeq] }),
  cursor: foreignKey({ name: "heartbeat_run_event_source_ranges_cursor_fk",
    columns: [table.companyId, table.runId, table.sourceInstanceId],
    foreignColumns: [heartbeatRunEventCursors.companyId, heartbeatRunEventCursors.runId, heartbeatRunEventCursors.sourceInstanceId],
  }).onDelete("cascade"),
  positive: check("heartbeat_run_event_source_ranges_positive", sql`${table.startSeq} >= 1 and ${table.endSeq} >= ${table.startSeq}`),
}));

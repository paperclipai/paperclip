import { bigint, check, foreignKey, pgTable, primaryKey, text, integer, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { heartbeatRuns } from "./heartbeat_runs.js";

/** Current server-observed process lifecycle. Historical output is never
 * scanned on ordinary stop/recovery checks, including when no process exists. */
export const nativeRunProcessEvidence = pgTable("native_run_process_evidence", {
  companyId: uuid("company_id").notNull(),
  runId: uuid("run_id").notNull(),
  seq: bigint("seq", { mode: "number" }).notNull(),
  eventType: text("event_type"),
  processPid: integer("process_pid"),
  processGroupId: integer("process_group_id"),
}, table => ({
  pk: primaryKey({ columns: [table.companyId, table.runId] }),
  runOwnerFk: foreignKey({ columns: [table.companyId, table.runId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id], name: "native_run_process_evidence_owner_fk" }).onDelete("cascade"),
  eventValid: check("native_run_process_evidence_event_valid", sql`(${table.seq} = 0 and ${table.eventType} is null) or (${table.seq} > 0 and ${table.eventType} is not null and ${table.eventType} in ('native.process_start_requested', 'native.process_identity_recorded', 'native.local_process_stopped'))`),
}));

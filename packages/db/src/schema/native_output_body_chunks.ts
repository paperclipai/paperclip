import { bigint, check, foreignKey, index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { eventIdentity } from "../event-identity.js";
import { sql } from "drizzle-orm";
import { heartbeatRunEvents } from "./heartbeat_run_events.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/** Tiny locator rows written atomically with native events. A new table avoids
 * scanning/locking the entire historical run log during feature activation. */
export const nativeOutputBodyChunks = pgTable("native_output_body_chunks", {
  companyId: uuid("company_id").notNull(),
  runId: uuid("run_id").notNull(),
  bodyId: text("body_id").notNull(),
  chunkOffset: bigint("chunk_offset", { mode: "number" }).notNull(),
  chunkSha256: text("chunk_sha256").notNull(),
  sourceSeq: bigint("source_seq", { mode: "number" }).notNull(),
  eventId: eventIdentity("event_id").notNull().references(() => heartbeatRunEvents.id, { onDelete: "cascade" }),
}, table => ({
  pk: primaryKey({ columns: [table.companyId, table.runId, table.bodyId, table.chunkOffset] }),
  eventIdx: index("native_output_body_chunks_event_idx").on(table.eventId),
  runOwnerFk: foreignKey({ columns: [table.companyId, table.runId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id], name: "native_output_body_chunks_run_owner_fk" }).onDelete("cascade"),
  bodyIdValid: check("native_output_body_chunks_body_id_valid", sql`${table.bodyId} ~ '^[a-f0-9]{64}$'`),
  chunkOffsetBound: check("native_output_body_chunks_offset_bound", sql`${table.chunkOffset} >= 0 and ${table.chunkOffset} < 4194304`),
  chunkHashValid: check("native_output_body_chunks_hash_valid", sql`${table.chunkSha256} ~ '^[a-f0-9]{64}$'`),
  sequencePositive: check("native_output_body_chunks_sequence_positive", sql`${table.sourceSeq} > 0`),
}));

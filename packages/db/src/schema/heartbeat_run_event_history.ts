import { bigint, foreignKey, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { heartbeatRunEvents } from "./heartbeat_run_events.js";
import { eventIdentity } from "../event-identity.js";

/** Closed public log namespaces are immutable. No lifetime epoch counter. */
export const heartbeatRunEventEpochs = pgTable("heartbeat_run_event_epochs", {
  companyId: uuid("company_id").notNull(),
  runId: uuid("run_id").notNull(),
  epoch: text("epoch").notNull(),
  nextEpoch: uuid("next_epoch").notNull(),
  finalSeq: bigint("final_seq", { mode: "number" }).notNull(),
}, table => ({
  pk: primaryKey({ columns: [table.runId, table.epoch] }),
  successorUq: uniqueIndex("heartbeat_run_event_epochs_successor_uq").on(table.runId, table.nextEpoch),
  runOwnerFk: foreignKey({ columns: [table.companyId, table.runId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id] }).onDelete("cascade"),
}));

/** Indexed newest-event anchors for semantic lanes. A lane is a fixed kind or
 * a digest of an exact request/type; it never contains an entire transcript. */
export const heartbeatRunEventHeads = pgTable("heartbeat_run_event_heads", {
  companyId: uuid("company_id").notNull(),
  runId: uuid("run_id").notNull(),
  lane: text("lane").notNull(),
  eventId: eventIdentity("event_id").notNull().references(() => heartbeatRunEvents.id, { onDelete: "cascade" }),
}, table => ({
  pk: primaryKey({ columns: [table.runId, table.lane] }),
  runOwnerFk: foreignKey({ columns: [table.companyId, table.runId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id] }).onDelete("cascade"),
}));

/** Immutable predecessor links let recent/filtered views fetch a bounded
 * window without sorting epoch UUIDs or searching old output for a match. */
export const heartbeatRunEventLinks = pgTable("heartbeat_run_event_links", {
  companyId: uuid("company_id").notNull(),
  runId: uuid("run_id").notNull(),
  lane: text("lane").notNull(),
  eventId: eventIdentity("event_id").notNull().references(() => heartbeatRunEvents.id, { onDelete: "cascade" }),
  previousId: eventIdentity("previous_id"),
}, table => ({
  pk: primaryKey({ columns: [table.runId, table.lane, table.eventId] }),
  runOwnerFk: foreignKey({ columns: [table.companyId, table.runId], foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.id] }).onDelete("cascade"),
}));

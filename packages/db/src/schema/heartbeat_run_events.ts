import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  bigserial,
  bigint,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const heartbeatRunEvents = pgTable(
  "heartbeat_run_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    seq: bigint("seq", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    stream: text("stream"),
    level: text("level"),
    color: text("color"),
    message: text("message"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    sourceInstanceId: text("source_instance_id"),
    sourceEventId: text("source_event_id"),
    sourceSeq: bigint("source_seq", { mode: "number" }),
    sourcePayloadSha256: text("source_payload_sha256"),
    protocolSchemaVersion: integer("protocol_schema_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSeqUq: uniqueIndex("heartbeat_run_events_run_seq_uq").on(table.runId, table.seq),
    runSourceEventUq: uniqueIndex("heartbeat_run_events_run_source_event_uq")
      .on(table.runId, table.sourceEventId)
      .where(sql`${table.sourceEventId} is not null`),
    runSourceSeqUq: uniqueIndex("heartbeat_run_events_run_source_seq_uq")
      .on(table.runId, table.sourceInstanceId, table.sourceSeq)
      .where(sql`${table.sourceInstanceId} is not null and ${table.sourceSeq} is not null`),
    companyRunIdx: index("heartbeat_run_events_company_run_idx").on(table.companyId, table.runId),
    companyCreatedIdx: index("heartbeat_run_events_company_created_idx").on(table.companyId, table.createdAt),
  }),
);

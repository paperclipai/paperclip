import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Read-model projector state for Work Entity
export const rt2V33WorkProjectorState = pgTable("rt2_v33_work_projector_state", {
  projectorName: text("projector_name").primaryKey(),
  status: text("status").notNull().default("idle"),
  lastEventId: uuid("last_event_id"),
  lastProcessedAt: timestamp("last_processed_at"),
  failureCount: integer("failure_count").notNull().default(0),
  lastError: text("last_error"),
  metadata: jsonb("metadata").notNull().default("{}"),
}, (table) => ({
  statusCheck: check(
    "rt2_v33_work_projector_state_status_check",
    sql`${table.status} in ('idle', 'running', 'failed')`,
  ),
}));

import { pgTable, text, uuid, timestamp, integer, jsonb } from "drizzle-orm";

// Read-model projector state for Work Entity
export const rt2V33WorkProjectorState = pgTable("rt2_v33_work_projector_state", {
  projectorName: text("projector_name").primaryKey(),
  status: text("status").notNull().default("idle"),
  lastEventId: uuid("last_event_id").nullable(),
  lastProcessedAt: timestamp("last_processed_at").nullable(),
  failureCount: integer("failure_count").notNull().default(0),
  lastError: text("last_error").nullable(),
  metadata: jsonb("metadata").notNull().default("{}"),
});

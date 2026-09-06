import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/** Metadata only. Exact provider bytes live in the restricted sidecar store. */
export const providerTraceRecords = pgTable(
  "provider_trace_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("capturing"),
    provider: text("provider").notNull(),
    traceRef: text("trace_ref").notNull(),
    frameCount: integer("frame_count").notNull().default(0),
    byteCount: bigint("byte_count", { mode: "number" }).notNull().default(0),
    digest: text("digest"),
    reason: text("reason"),
    requestedBy: text("requested_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runUnique: uniqueIndex("provider_trace_records_run_unique").on(table.runId),
    expiryIdx: index("provider_trace_records_expiry_idx").on(
      table.status,
      table.expiresAt,
    ),
    companyCreatedIdx: index("provider_trace_records_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);

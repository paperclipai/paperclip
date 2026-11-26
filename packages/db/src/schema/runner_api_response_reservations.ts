import { pgTable, uuid, bigint, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { assets } from "./assets.js";

export const runnerApiResponseReservations = pgTable("runner_api_response_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
  assetId: uuid("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
  pendingDeleteObjectKey: text("pending_delete_object_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  companyIdx: index("runner_api_response_reservations_company_idx").on(table.companyId),
  assetIdx: index("runner_api_response_reservations_asset_idx").on(table.assetId),
}));

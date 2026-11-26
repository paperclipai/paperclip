import { sql } from "drizzle-orm";
import { foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const nativeRunnerCheckpoints = pgTable("native_runner_checkpoints", {
  companyId: uuid("company_id").notNull(),
  runId: uuid("run_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  part: text("part").notNull(),
  material: jsonb("material").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  pk: primaryKey({ columns: [table.runId, table.part] }),
  headers: index("native_runner_checkpoints_headers_idx").on(table.runId).where(sql`${table.part} = 'header'`),
  run: foreignKey({ columns: [table.companyId, table.issueId, table.runId],
    foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.nativeIssueId, heartbeatRuns.id] }).onDelete("cascade"),
}));

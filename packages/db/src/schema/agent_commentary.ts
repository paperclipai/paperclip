import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/** Internal, attributed feedback. Company/run ownership is validated by the write service. */
export const agentCommentary = pgTable("agent_commentary", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
  kind: text("kind").$type<"complaint" | "suggestion">().notNull(),
  body: text("body").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  retryUq: uniqueIndex("agent_commentary_run_key_uq").on(table.companyId, table.runId, table.idempotencyKey),
  companyKindCreatedIdx: index("agent_commentary_company_kind_created_idx").on(table.companyId, table.kind, table.createdAt),
  kindCheck: check("agent_commentary_kind_check", sql`${table.kind} in ('complaint', 'suggestion')`),
}));

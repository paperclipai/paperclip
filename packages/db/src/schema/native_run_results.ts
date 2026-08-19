import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { completionContracts } from "./completion_contracts.js";

export const nativeRunResults = pgTable("native_run_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
  turnId: text("turn_id"),
  completionContractId: uuid("completion_contract_id").notNull().references(() => completionContracts.id),
  callerResultId: text("caller_result_id"),
  callerDedupeKey: text("caller_dedupe_key"),
  serverFingerprint: text("server_fingerprint").notNull(),
  schemaStatus: text("schema_status").notNull(),
  rejectionCode: text("rejection_code"),
  resultJson: jsonb("result_json").$type<Record<string, unknown>>().notNull(),
  canonicalSha256: text("canonical_sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runFingerprintUq: uniqueIndex("native_run_results_run_fingerprint_uq").on(table.runId, table.serverFingerprint),
  runCallerResultUq: uniqueIndex("native_run_results_run_caller_result_uq").on(table.runId, table.callerResultId),
  runCallerDedupeUq: uniqueIndex("native_run_results_run_caller_dedupe_uq").on(table.runId, table.callerDedupeKey),
}));

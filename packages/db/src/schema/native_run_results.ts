import {
  foreignKey,
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { completionContracts } from "./completion_contracts.js";

export const nativeRunResults = pgTable(
  "native_run_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull(),
    runId: uuid("run_id").notNull(),
    turnId: text("turn_id"),
    completionContractId: uuid("completion_contract_id").notNull(),
    callerResultId: text("caller_result_id"),
    callerDedupeKey: text("caller_dedupe_key"),
    serverFingerprint: text("server_fingerprint").notNull(),
    schemaStatus: text("schema_status").notNull(),
    rejectionCode: text("rejection_code"),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>().notNull(),
    canonicalSha256: text("canonical_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueRunIdUq: unique("native_run_results_company_issue_run_id_uq").on(
      table.companyId,
      table.issueId,
      table.runId,
      table.id,
    ),
    issueCompanyFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "native_run_results_issue_company_fk",
    }),
    runContractOwnerFk: foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.runId,
        table.completionContractId,
      ],
      foreignColumns: [
        heartbeatRuns.companyId,
        heartbeatRuns.nativeIssueId,
        heartbeatRuns.id,
        heartbeatRuns.completionContractId,
      ],
      name: "native_run_results_run_contract_owner_fk",
    }),
    completionContractOwnerFk: foreignKey({
      columns: [table.companyId, table.issueId, table.completionContractId],
      foreignColumns: [
        completionContracts.companyId,
        completionContracts.issueId,
        completionContracts.id,
      ],
      name: "native_run_results_completion_contract_owner_fk",
    }),
    runFingerprintUq: uniqueIndex("native_run_results_run_fingerprint_uq").on(
      table.runId,
      table.serverFingerprint,
    ),
    runCallerResultUq: uniqueIndex("native_run_results_run_caller_result_uq").on(
      table.runId,
      table.callerResultId,
    ),
    runCallerDedupeUq: uniqueIndex("native_run_results_run_caller_dedupe_uq").on(
      table.runId,
      table.callerDedupeKey,
    ),
  }),
);

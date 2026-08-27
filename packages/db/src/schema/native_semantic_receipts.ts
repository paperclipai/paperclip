import {
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const nativeSemanticReceipts = pgTable(
  "native_semantic_receipts",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull(),
    runId: uuid("run_id").notNull(),
    operationId: text("operation_id").notNull(),
    scopeDigest: text("scope_digest").notNull(),
    inputDigest: text("input_digest").notNull(),
    status: text("status").notNull().default("claimed"),
    outcome: jsonb("outcome").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueCompanyFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "native_semantic_receipts_issue_company_fk",
    }),
    runOwnerFk: foreignKey({
      columns: [table.companyId, table.issueId, table.runId],
      foreignColumns: [
        heartbeatRuns.companyId,
        heartbeatRuns.nativeIssueId,
        heartbeatRuns.id,
      ],
      name: "native_semantic_receipts_run_owner_fk",
    }),
    runScopeUq: uniqueIndex("native_semantic_receipts_run_scope_uq").on(
      table.runId,
      table.scopeDigest,
    ),
  }),
);

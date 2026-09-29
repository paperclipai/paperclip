import { foreignKey, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { heartbeatRuns } from "./heartbeat_runs.js";

/** Business-effect replay authority, independent of protocol delivery receipts.
 * The digest is an index key only; readers verify the original key exactly. */
export const nativeToolReceipts = pgTable("native_tool_receipts", {
  companyId: uuid("company_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  runId: uuid("run_id").notNull(),
  keySha256: text("key_sha256").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  receipt: jsonb("receipt").$type<unknown>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  pk: primaryKey({ name: "native_tool_receipts_pk", columns: [table.companyId, table.runId, table.keySha256] }),
  runOwnerFk: foreignKey({ name: "native_tool_receipts_run_owner_fk", columns: [table.companyId, table.issueId, table.runId],
    foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.nativeIssueId, heartbeatRuns.id] }).onDelete("cascade"),
}));

/** Point lookups for publication proof, attachment reuse and generated comments.
 * These references commit with their receipt and the business mutation. */
export const nativeToolReceiptReferences = pgTable("native_tool_receipt_references", {
  companyId: uuid("company_id").notNull(),
  runId: uuid("run_id").notNull(),
  kind: text("kind").notNull(),
  target: text("target").notNull(),
  keySha256: text("key_sha256").notNull(),
}, table => ({
  pk: primaryKey({ name: "native_tool_receipt_references_pk", columns: [table.companyId, table.runId, table.kind, table.target, table.keySha256] }),
  receiptFk: foreignKey({ name: "native_tool_receipt_references_receipt_fk", columns: [table.companyId, table.runId, table.keySha256],
    foreignColumns: [nativeToolReceipts.companyId, nativeToolReceipts.runId, nativeToolReceipts.keySha256] }).onDelete("cascade"),
}));

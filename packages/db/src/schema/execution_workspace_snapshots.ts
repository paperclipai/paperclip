import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** Durable object ledger deliberately survives deletion of its source records. */
export const executionWorkspaceSnapshots = pgTable("execution_workspace_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  executionWorkspaceId: uuid("execution_workspace_id").notNull(),
  sourceOperationId: uuid("source_operation_id").notNull(),
  sourceRunId: uuid("source_run_id"),
  parentSnapshotId: uuid("parent_snapshot_id"),
  generation: integer("generation").notNull(),
  epoch: integer("epoch").notNull(),
  status: text("status").$type<"pending" | "uploaded" | "committed" | "superseded" | "delete_requested" | "deleted">().notNull().default("pending"),
  format: text("format").notNull().default("paperclip.remote-workspace-archive.v1"),
  objectKey: text("object_key"),
  sha256: text("sha256"),
  byteSize: bigint("byte_size", { mode: "number" }),
  key: jsonb("key").$type<Record<string, unknown>>(),
  manifestDigest: text("manifest_digest"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  deleteAfter: timestamp("delete_after", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  operationUniqueIdx: uniqueIndex("execution_workspace_snapshots_operation_uniq").on(table.companyId, table.executionWorkspaceId, table.sourceOperationId),
  generationUniqueIdx: uniqueIndex("execution_workspace_snapshots_generation_uniq").on(table.companyId, table.executionWorkspaceId, table.generation),
  workspaceIdx: index("execution_workspace_snapshots_workspace_idx").on(table.companyId, table.executionWorkspaceId),
  cleanupIdx: index("execution_workspace_snapshots_cleanup_idx").on(table.status, table.deleteAfter),
}));

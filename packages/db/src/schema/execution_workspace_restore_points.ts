import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const EXECUTION_WORKSPACE_RESTORE_POINT_STATUSES = [
  "pending",
  "active",
  "expiring",
  "superseded",
  "delete_requested",
  "deleted",
] as const;
export type ExecutionWorkspaceRestorePointStatus = (typeof EXECUTION_WORKSPACE_RESTORE_POINT_STATUSES)[number];

export const executionWorkspaceRestorePoints = pgTable(
  "execution_workspace_restore_points",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    executionWorkspaceId: uuid("execution_workspace_id").notNull(),
    sourceIssueId: uuid("source_issue_id"),
    generation: integer("generation").notNull(),
    checkoutName: text("checkout_name").notNull().default(""),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    status: text("status").$type<ExecutionWorkspaceRestorePointStatus>().notNull().default("pending"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    treeClosedAt: timestamp("tree_closed_at", { withTimezone: true }),
    deleteAfter: timestamp("delete_after", { withTimezone: true }),
    reviewGeneration: integer("review_generation").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    objectKeyUniqueIdx: uniqueIndex("execution_workspace_restore_points_object_key_uniq").on(table.objectKey),
    liveGenerationUniqueIdx: uniqueIndex("execution_workspace_restore_points_live_checkout_uniq")
      .on(table.executionWorkspaceId, table.generation, table.checkoutName)
      .where(sql`${table.status} <> 'deleted'`),
    statusDeleteAfterIdx: index("execution_workspace_restore_points_status_delete_after_idx").on(table.status, table.deleteAfter),
    companyIdx: index("execution_workspace_restore_points_company_idx").on(table.companyId),
    sourceIssueIdx: index("execution_workspace_restore_points_source_issue_idx").on(table.companyId, table.sourceIssueId),
    activeSourceIdx: index("execution_workspace_restore_points_active_source_idx").on(table.sourceIssueId)
      .where(sql`${table.status} = 'active'`),
  }),
);

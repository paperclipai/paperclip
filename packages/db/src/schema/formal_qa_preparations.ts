import {
  type AnyPgColumn,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { projectWorkspaces } from "./project_workspaces.js";

/**
 * An immutable receipt for a requested formal-QA review.
 *
 * This is intentionally only a preparation authority. It is not an agent run,
 * it carries no filesystem path, and persisting it cannot execute a workspace
 * command. A later, separately-authorized lifecycle binds a verified detached
 * checkout and then creates a controlled run.
 */
export const formalQaPreparations = pgTable(
  "formal_qa_preparations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    projectWorkspaceId: uuid("project_workspace_id")
      .notNull()
      .references(() => projectWorkspaces.id),
    repository: text("repository").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    baseRef: text("base_ref").notNull(),
    baseSha: text("base_sha").notNull(),
    treeSha: text("tree_sha").notNull(),
    evidenceSha256: text("evidence_sha256").notNull(),
    issuerReceiptSha256: text("issuer_receipt_sha256").notNull(),
    issuerOperationId: text("issuer_operation_id").notNull(),
    issuedByUserId: text("issued_by_user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestSha256: text("request_sha256").notNull(),
    canonicalPreparationId: uuid("canonical_preparation_id")
      .references((): AnyPgColumn => formalQaPreparations.id),
    status: text("status").notNull().default("prepared"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdempotencyUq: uniqueIndex("formal_qa_preparations_company_idempotency_uq")
      .on(table.companyId, table.idempotencyKey),
    companyProjectCreatedIdx: index("formal_qa_preparations_company_project_created_idx")
      .on(table.companyId, table.projectId, table.createdAt),
    companyPrHeadIdx: index("formal_qa_preparations_company_pr_head_idx")
      .on(table.companyId, table.repository, table.prNumber, table.headSha),
  }),
);

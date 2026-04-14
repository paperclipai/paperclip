import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ReviewedArtifactContextType,
  ReviewedArtifactDisplayHint,
  ReviewedArtifactSelectionMode,
  ReviewedArtifactSourceType,
} from "@paperclipai/shared";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { companies } from "./companies.js";
import { documentRevisions } from "./document_revisions.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueAttachments } from "./issue_attachments.js";
import { issueWorkProducts } from "./issue_work_products.js";
import { issues } from "./issues.js";

export const reviewedArtifactSets = pgTable(
  "reviewed_artifact_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    contextType: text("context_type").$type<ReviewedArtifactContextType>().notNull(),
    contextIssueId: uuid("context_issue_id").references(() => issues.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "cascade" }),
    selectionMode: text("selection_mode").$type<ReviewedArtifactSelectionMode>().notNull().default("explicit"),
    title: text("title"),
    description: text("description"),
    supersededBySetId: uuid("superseded_by_set_id").references(
      (): AnyPgColumn => reviewedArtifactSets.id,
      { onDelete: "set null" },
    ),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyContextIdx: index("reviewed_artifact_sets_company_context_idx").on(
      table.companyId,
      table.contextType,
      table.contextIssueId,
      table.approvalId,
    ),
    companyUpdatedIdx: index("reviewed_artifact_sets_company_updated_idx").on(
      table.companyId,
      table.updatedAt,
    ),
    supersededByIdx: index("reviewed_artifact_sets_superseded_by_idx").on(table.supersededBySetId),
    activeIssueReviewUq: uniqueIndex("reviewed_artifact_sets_active_issue_review_uq")
      .on(table.companyId, table.contextIssueId)
      .where(sql`${table.contextType} = 'issue_review' and ${table.selectionMode} = 'explicit' and ${table.supersededAt} is null`),
    activeApprovalUq: uniqueIndex("reviewed_artifact_sets_active_approval_uq")
      .on(table.companyId, table.approvalId)
      .where(sql`${table.contextType} = 'approval' and ${table.selectionMode} = 'explicit' and ${table.supersededAt} is null`),
  }),
);

export const reviewedArtifactItems = pgTable(
  "reviewed_artifact_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    setId: uuid("set_id").notNull().references(() => reviewedArtifactSets.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull(),
    sourceType: text("source_type").$type<ReviewedArtifactSourceType>().notNull(),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "set null" }),
    sourceDocumentKey: text("source_document_key"),
    sourceDocumentRevisionId: uuid("source_document_revision_id")
      .references(() => documentRevisions.id, { onDelete: "set null" }),
    sourceIssueAttachmentId: uuid("source_issue_attachment_id")
      .references(() => issueAttachments.id, { onDelete: "set null" }),
    sourceIssueWorkProductId: uuid("source_issue_work_product_id")
      .references(() => issueWorkProducts.id, { onDelete: "set null" }),
    sourceExternalUrl: text("source_external_url"),
    sourceApprovalPayloadPointer: text("source_approval_payload_pointer"),
    sourceExecutionWorkspaceId: uuid("source_execution_workspace_id")
      .references(() => executionWorkspaces.id, { onDelete: "set null" }),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    sourceWorkspacePath: text("source_workspace_path"),
    title: text("title"),
    description: text("description"),
    displayHint: text("display_hint").$type<ReviewedArtifactDisplayHint>(),
    isPrimary: boolean("is_primary").notNull().default(false),
    required: boolean("required").notNull().default(false),
    selectedExplicitly: boolean("selected_explicitly").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    setOrderUq: uniqueIndex("reviewed_artifact_items_set_order_uq").on(table.setId, table.orderIndex),
    companySetIdx: index("reviewed_artifact_items_company_set_idx").on(table.companyId, table.setId),
    companySourceIssueIdx: index("reviewed_artifact_items_company_source_issue_idx").on(
      table.companyId,
      table.sourceIssueId,
    ),
    companySourceTypeIdx: index("reviewed_artifact_items_company_source_type_idx").on(
      table.companyId,
      table.sourceType,
    ),
  }),
);

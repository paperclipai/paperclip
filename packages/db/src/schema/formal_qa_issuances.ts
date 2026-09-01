import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { formalQaPreparations } from "./formal_qa_preparations.js";
import { projects } from "./projects.js";
import { projectWorkspaces } from "./project_workspaces.js";

/**
 * Immutable, server-derived GitHub evidence that authorizes a prepared
 * Formal-QA checkout. Board-created preparations remain inert until this
 * separate record exists; its digest is never supplied by a route caller.
 */
export const formalQaIssuances = pgTable(
  "formal_qa_issuances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    preparationId: uuid("preparation_id")
      .notNull()
      .references(() => formalQaPreparations.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    projectWorkspaceId: uuid("project_workspace_id")
      .notNull()
      .references(() => projectWorkspaces.id),
    repository: text("repository").notNull(),
    prNumber: text("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    baseRef: text("base_ref").notNull(),
    baseSha: text("base_sha").notNull(),
    treeSha: text("tree_sha").notNull(),
    requiredCheckName: text("required_check_name").notNull(),
    requiredCheckAppSlug: text("required_check_app_slug").notNull(),
    checkRunId: text("check_run_id").notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    preparationUq: uniqueIndex("formal_qa_issuances_preparation_uq").on(table.preparationId),
    companyProjectCreatedIdx: index("formal_qa_issuances_company_project_created_idx")
      .on(table.companyId, table.projectId, table.createdAt),
  }),
);

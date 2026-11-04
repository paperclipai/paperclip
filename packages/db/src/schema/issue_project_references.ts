import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";

/**
 * Reverse-lookup candidates for a task's project references, kept by triggers
 * in the same statement as each source write (migration 0432). A superset of
 * the structured parser's result: every UUID inside a `project://` link. There
 * is no project foreign key, so missing and foreign IDs stay visible. Never
 * admission truth; the context owner re-parses the sources under the task lock.
 */
export const issueProjectReferences = pgTable("issue_project_references", {
  companyId: uuid("company_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  sourceKind: text("source_kind").$type<"issue" | "comment" | "document" | "annotation" | "interaction" | "case">().notNull(),
  sourceId: uuid("source_id").notNull(),
  projectId: uuid("project_id").notNull(),
}, t => ({
  identity: primaryKey({ columns: [t.issueId, t.sourceKind, t.sourceId, t.projectId] }),
  issue: foreignKey({ columns: [t.companyId, t.issueId], foreignColumns: [issues.companyId, issues.id],
    name: "issue_project_references_company_issue_fk" }).onDelete("cascade"),
  project: index("issue_project_references_company_project_idx").on(t.companyId, t.projectId),
  sourceKindCheck: check("issue_project_references_source_kind_check",
    sql`${t.sourceKind} in ('issue', 'comment', 'document', 'annotation', 'interaction', 'case')`),
}));

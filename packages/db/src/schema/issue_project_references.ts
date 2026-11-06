import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";

export type IssueProjectReferenceSourceKind =
  "issue" | "comment" | "document" | "annotation" | "interaction" | "case" | "accepted_plan";

/**
 * Reverse-lookup candidates for a task's project references, kept by triggers
 * in the same statement as each source write (migration 0438). A superset of
 * the structured parser's result: every UUID inside a `project://` link.
 * `accepted_plan` rows come from accepted plan confirmations (source: the
 * immutable revision). No foreign keys: a key check would lock the task row
 * inside source writes, and missing or foreign project IDs must stay visible.
 * Task deletion removes the rows. Never admission truth; the context owner
 * re-parses the sources.
 */
export const issueProjectReferences = pgTable("issue_project_references", {
  companyId: uuid("company_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  sourceKind: text("source_kind").$type<IssueProjectReferenceSourceKind>().notNull(),
  sourceId: uuid("source_id").notNull(),
  projectId: uuid("project_id").notNull(),
}, t => ({
  identity: primaryKey({ columns: [t.issueId, t.sourceKind, t.sourceId, t.projectId] }),
  project: index("issue_project_references_company_project_idx").on(t.companyId, t.projectId),
  sourceKindCheck: check("issue_project_references_source_kind_check",
    sql`${t.sourceKind} in ('issue', 'comment', 'document', 'annotation', 'interaction', 'case', 'accepted_plan')`),
}));

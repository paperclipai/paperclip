import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const ISSUE_RELATION_TYPES = ["blocks", "duplicate_of"] as const;
export type IssueRelationType = (typeof ISSUE_RELATION_TYPES)[number];

export const issueRelations = pgTable(
  "issue_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    relatedIssueId: uuid("related_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    type: text("type").$type<IssueRelationType>().notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("issue_relations_company_issue_idx").on(table.companyId, table.issueId),
    companyRelatedIssueIdx: index("issue_relations_company_related_issue_idx").on(table.companyId, table.relatedIssueId),
    companyTypeIdx: index("issue_relations_company_type_idx").on(table.companyId, table.type),
    companyEdgeUq: uniqueIndex("issue_relations_company_edge_uq").on(
      table.companyId,
      table.issueId,
      table.relatedIssueId,
      table.type,
    ),
    duplicateOfIssueUq: uniqueIndex("issue_relations_duplicate_of_issue_uq")
      .on(table.companyId, table.issueId, table.type)
      .where(sql`${table.type} = 'duplicate_of'`),
    duplicateOfCanonicalIdx: index("issue_relations_duplicate_of_canonical_idx")
      .on(table.companyId, table.relatedIssueId)
      .where(sql`${table.type} = 'duplicate_of'`),
  }),
);

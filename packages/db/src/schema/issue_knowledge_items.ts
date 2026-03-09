import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { knowledgeItems } from "./knowledge_items.js";
import { agents } from "./agents.js";

export const issueKnowledgeItems = pgTable(
  "issue_knowledge_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    knowledgeItemId: uuid("knowledge_item_id")
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("issue_knowledge_items_company_issue_idx").on(
      table.companyId,
      table.issueId,
      table.sortOrder,
    ),
    companyKnowledgeIdx: index("issue_knowledge_items_company_knowledge_idx").on(
      table.companyId,
      table.knowledgeItemId,
    ),
    issueKnowledgeUq: uniqueIndex("issue_knowledge_items_issue_knowledge_uq").on(
      table.issueId,
      table.knowledgeItemId,
    ),
  }),
);

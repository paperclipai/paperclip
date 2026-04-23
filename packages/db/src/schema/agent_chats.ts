import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { issueComments } from "./issue_comments.js";
import { sql } from "drizzle-orm";

export const agentChats = pgTable(
  "agent_chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    initiatedByUserId: text("initiated_by_user_id").notNull(),
    title: text("title"),
    status: text("status").notNull().default("active"),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    anchorCommentId: uuid("anchor_comment_id").references(() => issueComments.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("agent_chats_company_agent_idx").on(table.companyId, table.agentId),
    companyUserIdx: index("agent_chats_company_user_idx").on(table.companyId, table.initiatedByUserId),
    quickChatUniqueIdx: uniqueIndex("agent_chats_quick_chat_idx")
      .on(table.agentId, table.anchorCommentId)
      .where(sql`${table.anchorCommentId} is not null`),
  }),
);

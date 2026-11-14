import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentCommentary } from "./agent_commentary.js";
import { companies } from "./companies.js";

export const agentCommentaryVotes = pgTable("agent_commentary_votes", {
  commentaryId: uuid("commentary_id").notNull().references(() => agentCommentary.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.commentaryId, table.userId] }),
  companyUserIdx: index("agent_commentary_votes_company_user_idx").on(table.companyId, table.userId),
}));

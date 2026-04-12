import { pgTable, uuid, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { agentChats } from "./agent_chats.js";

export const voiceCommands = pgTable(
  "voice_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    routerAgentId: uuid("router_agent_id").references(() => agents.id),
    initiatedByUserId: text("initiated_by_user_id").notNull(),
    rawText: text("raw_text").notNull(),
    classification: text("classification"), // 'new_app' | 'bug' | 'feature' | 'task' | 'question' | null (pending)
    actionTaken: text("action_taken"), // description of what the router did
    createdIssueId: uuid("created_issue_id").references(() => issues.id),
    chatId: uuid("chat_id").references(() => agentChats.id),
    status: text("status").notNull().default("pending"), // 'pending' | 'processing' | 'completed' | 'corrected' | 'failed'
    correctionHistory: jsonb("correction_history").$type<
      Array<{
        correctedAt: string;
        correctionText: string;
        previousClassification: string | null;
        newClassification: string | null;
        previousIssueId: string | null;
        newIssueId: string | null;
        action: string; // 'reclassified' | 'cancelled' | 'recreated' | 'updated'
      }>
    >(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("voice_commands_company_user_idx").on(table.companyId, table.initiatedByUserId),
    companyCreatedIdx: index("voice_commands_company_created_idx").on(table.companyId, table.createdAt),
    companyStatusIdx: index("voice_commands_company_status_idx").on(table.companyId, table.status),
    createdIssueIdx: index("voice_commands_created_issue_idx").on(table.createdIssueId),
  }),
);

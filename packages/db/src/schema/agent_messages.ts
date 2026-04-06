import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    fromAgentId: uuid("from_agent_id").notNull().references(() => agents.id),
    toAgentId: uuid("to_agent_id").references(() => agents.id),
    broadcastScope: text("broadcast_scope"),
    messageType: text("message_type").notNull().default("general"),
    subject: text("subject"),
    body: text("body").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyFromIdx: index("agent_messages_company_from_idx").on(table.companyId, table.fromAgentId),
    companyToIdx: index("agent_messages_company_to_idx").on(table.companyId, table.toAgentId),
    toAgentCreatedIdx: index("agent_messages_to_agent_created_idx").on(table.toAgentId, table.createdAt),
  }),
);

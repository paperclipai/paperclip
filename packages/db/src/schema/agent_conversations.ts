import { pgTable, text, timestamp, uuid, jsonb, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const agentConversations = pgTable(
  "agent_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_agent_conversations_agent_id").on(table.agentId),
    index("idx_agent_conversations_created_at").on(table.createdAt.desc()),
    index("idx_agent_conversations_agent_created").on(table.agentId, table.createdAt.desc()),
  ]
);

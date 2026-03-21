import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { sparringSessions } from "./sparring_sessions.js";

export const sparringParticipants = pgTable(
  "sparring_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sparringSessions.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    role: text("role"),
    status: text("status").notNull().default("invited"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionAgentUnique: uniqueIndex("sparring_participants_session_agent_unique").on(table.sessionId, table.agentId),
    sessionIdx: index("sparring_participants_session_idx").on(table.sessionId),
  }),
);

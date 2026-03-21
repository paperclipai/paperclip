import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { sparringSessions } from "./sparring_sessions.js";

export const sparringTurns = pgTable(
  "sparring_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sparringSessions.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    roundNumber: integer("round_number").notNull(),
    turnNumber: integer("turn_number").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("sparring_turns_session_idx").on(table.sessionId),
    sessionTurnIdx: index("sparring_turns_session_turn_idx").on(table.sessionId, table.turnNumber),
  }),
);

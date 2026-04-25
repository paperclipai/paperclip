import { index, pgTable, text, timestamp, uuid, integer } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const agentIdleState = pgTable(
  "agent_idle_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("active"),
    emptyHeartbeatStreak: integer("empty_heartbeat_streak").notNull().default(0),
    lastMeaningfulActionAt: timestamp("last_meaningful_action_at", { withTimezone: true }),
    quiescedAt: timestamp("quiesced_at", { withTimezone: true }),
    nextWatchdogAt: timestamp("next_watchdog_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdIdx: index("agent_idle_state_agent_id_idx").on(table.agentId),
    stateIdx: index("agent_idle_state_state_idx").on(table.state),
    nextWatchdogIdx: index("agent_idle_state_next_watchdog_idx").on(table.nextWatchdogAt),
    agentIdUq: index("agent_idle_state_agent_id_uq").on(table.agentId),
  }),
);

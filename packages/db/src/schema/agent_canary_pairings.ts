import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const agentCanaryPairings = pgTable(
  "agent_canary_pairings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: text("role").notNull().unique(),
    primaryModel: text("primary_model").notNull(),
    challengerModel: text("challenger_model").notNull(),
    primaryHarness: text("primary_harness").notNull(),
    challengerHarness: text("challenger_harness").notNull(),
    canaryPercent: integer("canary_percent").notNull().default(20),
    status: text("status").$type<"active" | "paused" | "promoted" | "rejected">().notNull().default("active"),
    trialsStartedAt: timestamp("trials_started_at", { withTimezone: true }),
    trialsCompletedAt: timestamp("trials_completed_at", { withTimezone: true }),
    recommendation: text("recommendation"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roleIdx: uniqueIndex("agent_canary_pairings_role_idx").on(table.role),
    statusIdx: index("agent_canary_pairings_status_idx").on(table.status),
  }),
);

export type AgentCanaryPairing = typeof agentCanaryPairings.$inferSelect;
export type NewAgentCanaryPairing = typeof agentCanaryPairings.$inferInsert;
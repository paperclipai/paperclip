import {
  pgTable,
  uuid,
  text,
  real,
  boolean,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const agentRoleCandidates = pgTable(
  "agent_role_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: text("role").notNull(),
    model: text("model").notNull(),
    harness: text("harness").notNull(),
    subscription: text("subscription").notNull(),
    provider: text("provider").notNull(),
    qualityRank: real("quality_rank").notNull().default(1.0),
    isSaturated: boolean("is_saturated").notNull().default(false),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roleModelHarnessUnique: index("agent_role_candidates_role_model_harness_unique").on(
      table.role,
      table.model,
      table.harness,
    ),
    roleIdx: index("agent_role_candidates_role_idx").on(table.role),
    subscriptionIdx: index("agent_role_candidates_subscription_idx").on(
      table.subscription,
      table.isSaturated,
    ),
  }),
);

export type AgentRoleCandidate = typeof agentRoleCandidates.$inferSelect;
export type NewAgentRoleCandidate = typeof agentRoleCandidates.$inferInsert;
import { index, pgTable, text, timestamp, uuid, boolean, jsonb, bigint } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const agentContextCache = pgTable(
  "agent_context_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    lastContext: jsonb("last_context").$type<Record<string, unknown>>().notNull(),
    lastLoadedAt: timestamp("last_loaded_at", { withTimezone: true }).notNull(),
    cachedAtXactId: text("cached_at_xact_id").notNull(),
    dataVersion: bigint("data_version", { mode: "number" }).notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    fetchOnDemand: boolean("fetch_on_demand").notNull().default(false),
    summary: text("summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdUq: index("agent_context_cache_agent_id_uq").on(table.agentId),
    expiresAtIdx: index("agent_context_cache_expires_at_idx").on(table.expiresAt),
  }),
);

export type AgentContextCache = typeof agentContextCache.$inferSelect;
export type NewAgentContextCache = typeof agentContextCache.$inferInsert;

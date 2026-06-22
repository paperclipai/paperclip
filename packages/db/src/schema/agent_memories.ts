import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Per-agent long-term memory (issue #6).
 *
 * Postgres is the source of truth; a rendered MEMORY.md is derived from the
 * `active` rows for inspection. Memory is partitioned by `agentId` (the durable
 * agent identity) so renaming an agent's role never resets its memory.
 *
 * Memory types follow the CoALA taxonomy:
 * - `episodic`:   what happened (a specific past interaction)
 * - `semantic`:   durable facts and preferences
 * - `procedural`: learned procedures and rules
 * - `lesson`:     a capitalized lesson from an incident
 */
export const agentMemories = pgTable(
  "agent_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("semantic"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("active"),
    confidence: integer("confidence").notNull().default(0),
    tags: text("tags").array().notNull().default([]),
    // Provenance back to the work that produced the memory (all nullable).
    sourceRunId: uuid("source_run_id"),
    sourceIssueId: uuid("source_issue_id"),
    sourceCommentId: uuid("source_comment_id"),
    recallCount: integer("recall_count").notNull().default(0),
    lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true }),
    // Correction chain: a new memory may supersede an older one.
    supersedesMemoryId: uuid("supersedes_memory_id").references((): AnyPgColumn => agentMemories.id, {
      onDelete: "set null",
    }),
    supersededByMemoryId: uuid("superseded_by_memory_id").references((): AnyPgColumn => agentMemories.id, {
      onDelete: "set null",
    }),
    createdByActorType: text("created_by_actor_type"),
    createdByActorId: text("created_by_actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    forgottenAt: timestamp("forgotten_at", { withTimezone: true }),
  },
  (table) => ({
    companyAgentStatusIdx: index("agent_memories_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    agentTypeStatusIdx: index("agent_memories_agent_type_status_idx").on(
      table.agentId,
      table.type,
      table.status,
    ),
    agentUpdatedIdx: index("agent_memories_agent_updated_idx").on(table.agentId, table.updatedAt),
    tagsIdx: index("agent_memories_tags_idx").using("gin", table.tags),
  }),
);

/**
 * Audit record for a memory consolidation ("dreaming") pass over one agent.
 */
export const agentMemoryConsolidationRuns = pgTable(
  "agent_memory_consolidation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"),
    ingested: integer("ingested").notNull().default(0),
    staged: integer("staged").notNull().default(0),
    promoted: integer("promoted").notNull().default(0),
    forgotten: integer("forgotten").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStartedIdx: index("agent_memory_consolidation_company_agent_started_idx").on(
      table.companyId,
      table.agentId,
      table.startedAt,
    ),
    agentStartedIdx: index("agent_memory_consolidation_agent_started_idx").on(table.agentId, table.startedAt),
  }),
);

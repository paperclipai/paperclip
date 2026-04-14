import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

// ---------------------------------------------------------------------------
// evolution_prompt_variants — versioned agent instructions for A/B testing
// ---------------------------------------------------------------------------
export const evolutionPromptVariants = pgTable(
  "evolution_prompt_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    instructions: text("instructions").notNull(),
    parentVariantId: uuid("parent_variant_id").references(
      (): AnyPgColumn => evolutionPromptVariants.id,
    ),
    mutationStrategy: text("mutation_strategy"),
    status: text("status").notNull().default("active"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyAgentStatusIdx: index(
      "evolution_prompt_variants_company_agent_status_idx",
    ).on(table.companyId, table.agentId, table.status),
  }),
);

// ---------------------------------------------------------------------------
// evolution_runs — a single evolution evaluation run
// ---------------------------------------------------------------------------
export const evolutionRuns = pgTable(
  "evolution_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    variantIds: jsonb("variant_ids").$type<string[]>().notNull(),
    baselineVariantId: uuid("baseline_variant_id").references(
      () => evolutionPromptVariants.id,
    ),
    winnerVariantId: uuid("winner_variant_id").references(
      () => evolutionPromptVariants.id,
    ),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("evolution_runs_company_status_idx").on(
      table.companyId,
      table.status,
    ),
  }),
);

// ---------------------------------------------------------------------------
// evolution_run_tasks — individual task results within a run
// ---------------------------------------------------------------------------
export const evolutionRunTasks = pgTable(
  "evolution_run_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => evolutionRuns.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => evolutionPromptVariants.id),
    issueId: uuid("issue_id").references(() => issues.id, {
      onDelete: "set null",
    }),
    taskDescription: text("task_description").notNull(),
    outcome: text("outcome").notNull(),
    qualityScore: integer("quality_score"),
    durationMs: integer("duration_ms"),
    costCents: integer("cost_cents"),
    tokenCount: integer("token_count"),
    toolCallCount: integer("tool_call_count"),
    errorCount: integer("error_count"),
    error: text("error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runVariantIdx: index("evolution_run_tasks_run_variant_idx").on(
      table.runId,
      table.variantId,
    ),
  }),
);

// ---------------------------------------------------------------------------
// evolution_fitness_scores — aggregated fitness per variant per run
// ---------------------------------------------------------------------------
export const evolutionFitnessScores = pgTable(
  "evolution_fitness_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => evolutionRuns.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => evolutionPromptVariants.id),
    quality: integer("quality").notNull(),
    speedScore: integer("speed_score").notNull(),
    costScore: integer("cost_score").notNull(),
    successRate: integer("success_rate").notNull(),
    compositeScore: integer("composite_score").notNull(),
    isParetoOptimal: text("is_pareto_optimal").notNull().default("false"),
    objectives: jsonb("objectives").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runVariantUniqueIdx: uniqueIndex(
      "evolution_fitness_scores_run_variant_idx",
    ).on(table.runId, table.variantId),
  }),
);

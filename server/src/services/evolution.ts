import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  evolutionPromptVariants,
  evolutionRuns,
  evolutionRunTasks,
} from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { fitnessEvaluatorService, type VariantFitness, type TaskResult } from "./fitness-evaluator.js";

export function evolutionService(db: Db) {
  const fitness = fitnessEvaluatorService(db);

  return {
    // ── Variant management ──────────────────────────────────────────────

    async createVariant(params: {
      companyId: string;
      agentId: string;
      name: string;
      instructions: string;
      parentVariantId?: string;
      mutationStrategy?: string;
    }) {
      const [variant] = await db
        .insert(evolutionPromptVariants)
        .values({
          companyId: params.companyId,
          agentId: params.agentId,
          name: params.name,
          instructions: params.instructions,
          parentVariantId: params.parentVariantId,
          mutationStrategy: params.mutationStrategy,
        })
        .returning();
      return variant;
    },

    async listVariants(params: {
      companyId: string;
      agentId: string;
      status?: string;
    }) {
      const conditions = [
        eq(evolutionPromptVariants.companyId, params.companyId),
        eq(evolutionPromptVariants.agentId, params.agentId),
      ];
      if (params.status) {
        conditions.push(eq(evolutionPromptVariants.status, params.status));
      }
      return db
        .select()
        .from(evolutionPromptVariants)
        .where(and(...conditions))
        .orderBy(desc(evolutionPromptVariants.createdAt));
    },

    async getVariant(id: string) {
      const [variant] = await db
        .select()
        .from(evolutionPromptVariants)
        .where(eq(evolutionPromptVariants.id, id));
      if (!variant) throw notFound("Variant not found");
      return variant;
    },

    async archiveVariant(id: string) {
      const [variant] = await db
        .update(evolutionPromptVariants)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(evolutionPromptVariants.id, id))
        .returning();
      if (!variant) throw notFound("Variant not found");
      return variant;
    },

    // ── Run management ──────────────────────────────────────────────────

    async createRun(params: {
      companyId: string;
      name?: string;
      variantIds: string[];
      baselineVariantId?: string;
      config?: Record<string, unknown>;
    }) {
      if (params.variantIds.length === 0) {
        throw unprocessable("At least one variant is required");
      }

      // Validate all variants exist and belong to the same company
      const variants = await db
        .select()
        .from(evolutionPromptVariants)
        .where(inArray(evolutionPromptVariants.id, params.variantIds));

      if (variants.length !== params.variantIds.length) {
        const found = new Set(variants.map((v) => v.id));
        const missing = params.variantIds.filter((id) => !found.has(id));
        throw notFound(`Variants not found: ${missing.join(", ")}`);
      }

      const companies = new Set(variants.map((v) => v.companyId));
      if (companies.size > 1 || !companies.has(params.companyId)) {
        throw unprocessable(
          "All variants must belong to the same company as the run",
        );
      }

      const [run] = await db
        .insert(evolutionRuns)
        .values({
          companyId: params.companyId,
          name: params.name ?? null,
          variantIds: params.variantIds,
          baselineVariantId: params.baselineVariantId,
          config: params.config ?? {},
        })
        .returning();
      return run;
    },

    async getRun(id: string) {
      const [run] = await db
        .select()
        .from(evolutionRuns)
        .where(eq(evolutionRuns.id, id));
      if (!run) throw notFound("Run not found");
      return run;
    },

    async listRuns(params: { companyId: string; status?: string; limit?: number }) {
      const conditions = [eq(evolutionRuns.companyId, params.companyId)];
      if (params.status) {
        conditions.push(eq(evolutionRuns.status, params.status));
      }
      return db
        .select()
        .from(evolutionRuns)
        .where(and(...conditions))
        .orderBy(desc(evolutionRuns.createdAt))
        .limit(params.limit ?? 50);
    },

    // ── Execution ───────────────────────────────────────────────────────

    async recordTaskResult(params: {
      runId: string;
      variantId: string;
      issueId?: string;
      taskDescription: string;
      outcome: string;
      qualityScore?: number;
      durationMs?: number;
      costCents?: number;
      tokenCount?: number;
      toolCallCount?: number;
      errorCount?: number;
      error?: string;
      metadata?: Record<string, unknown>;
    }) {
      // Check if this is the run's first task result
      const [existingTask] = await db
        .select({ id: evolutionRunTasks.id })
        .from(evolutionRunTasks)
        .where(eq(evolutionRunTasks.runId, params.runId))
        .limit(1);

      if (!existingTask) {
        // First result — transition run to 'running'
        await db
          .update(evolutionRuns)
          .set({ status: "running", startedAt: new Date() })
          .where(
            and(
              eq(evolutionRuns.id, params.runId),
              eq(evolutionRuns.status, "pending"),
            ),
          );
      }

      const [task] = await db
        .insert(evolutionRunTasks)
        .values({
          runId: params.runId,
          variantId: params.variantId,
          issueId: params.issueId,
          taskDescription: params.taskDescription,
          outcome: params.outcome,
          qualityScore: params.qualityScore,
          durationMs: params.durationMs,
          costCents: params.costCents,
          tokenCount: params.tokenCount,
          toolCallCount: params.toolCallCount,
          errorCount: params.errorCount,
          error: params.error,
          metadata: params.metadata,
        })
        .returning();
      return task;
    },

    // ── Finalization ────────────────────────────────────────────────────

    async finalizeRun(runId: string) {
      const [run] = await db
        .select()
        .from(evolutionRuns)
        .where(eq(evolutionRuns.id, runId));
      if (!run) throw notFound("Run not found");

      const tasks = await db
        .select()
        .from(evolutionRunTasks)
        .where(eq(evolutionRunTasks.runId, runId));

      // No task results → mark failed, no winner
      if (tasks.length === 0) {
        const [failedRun] = await db
          .update(evolutionRuns)
          .set({ status: "failed", completedAt: new Date() })
          .where(eq(evolutionRuns.id, runId))
          .returning();
        return failedRun;
      }

      // Group tasks by variantId
      const tasksByVariant = new Map<string, typeof tasks>();
      for (const task of tasks) {
        const group = tasksByVariant.get(task.variantId) ?? [];
        group.push(task);
        tasksByVariant.set(task.variantId, group);
      }

      // Score each variant
      const variantIds = [...tasksByVariant.keys()];
      const scores = variantIds.map((variantId) => {
        const result = fitness.scoreVariant(tasksByVariant.get(variantId)! as TaskResult[]);
        return { ...result, variantId, isParetoOptimal: false } as VariantFitness;
      });

      // Determine Pareto frontier and winner
      const compared = fitness.compareVariants(scores);
      const winner = fitness.selectWinner(compared);

      // Persist fitness scores
      await fitness.saveFitnessScores(runId, compared);

      // Update the run
      const [completedRun] = await db
        .update(evolutionRuns)
        .set({
          status: "completed",
          completedAt: new Date(),
          winnerVariantId: winner ?? null,
        })
        .where(eq(evolutionRuns.id, runId))
        .returning();

      return { ...completedRun, scores: compared, winner };
    },

    // ── Promotion ───────────────────────────────────────────────────────

    async promoteVariant(params: { runId: string; variantId: string }) {
      // Load the variant
      const [variant] = await db
        .select()
        .from(evolutionPromptVariants)
        .where(eq(evolutionPromptVariants.id, params.variantId));
      if (!variant) throw notFound("Variant not found");

      if (variant.status === "promoted") {
        throw conflict("Variant has already been promoted");
      }

      // Load the agent and update its instructions
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, variant.agentId));
      if (!agent) throw notFound("Agent not found");

      await db
        .update(agents)
        .set({
          capabilities: variant.instructions,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, variant.agentId));

      // Mark the variant as promoted
      const now = new Date();
      const [promoted] = await db
        .update(evolutionPromptVariants)
        .set({ status: "promoted", promotedAt: now, updatedAt: now })
        .where(eq(evolutionPromptVariants.id, params.variantId))
        .returning();

      // Archive all other active variants for this agent
      await db
        .update(evolutionPromptVariants)
        .set({ status: "archived", updatedAt: now })
        .where(
          and(
            eq(evolutionPromptVariants.agentId, variant.agentId),
            eq(evolutionPromptVariants.status, "active"),
          ),
        );

      return promoted;
    },
  };
}

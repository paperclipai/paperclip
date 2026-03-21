import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";

interface WorkflowStepDef {
  adapterType: string;
  action?: string;
  prompt?: string;
  model?: string;
  dependsOn?: number[];
  config?: Record<string, unknown>;
}

export function workflowService(db: Db) {
  return {
    /** Create a new workflow run linked to an issue */
    async create(
      companyId: string,
      data: {
        issueId?: string;
        name?: string;
        steps: WorkflowStepDef[];
        createdBy?: string;
        onStepFailure?: string;
        maxRetries?: number;
        timeoutPerStepMs?: number;
      },
    ) {
      const [workflow] = await db
        .insert(workflowRuns)
        .values({
          companyId,
          issueId: data.issueId ?? null,
          name: data.name ?? null,
          steps: data.steps,
          createdBy: data.createdBy ?? "system",
          onStepFailure: data.onStepFailure ?? "pause",
          maxRetries: data.maxRetries ?? 1,
          timeoutPerStepMs: data.timeoutPerStepMs ?? 300_000,
        })
        .returning();

      // Pre-create step run records
      if (data.steps.length > 0) {
        await db.insert(workflowStepRuns).values(
          data.steps.map((step, index) => ({
            workflowRunId: workflow!.id,
            stepIndex: index,
            adapterType: step.adapterType,
            prompt: step.prompt ?? null,
          })),
        );
      }

      return workflow!;
    },

    /** Get a workflow run by ID */
    async getById(id: string) {
      const workflow = await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, id))
        .then((rows) => rows[0] ?? null);

      if (!workflow) return null;

      const steps = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, id))
        .orderBy(workflowStepRuns.stepIndex);

      return { ...workflow, stepRuns: steps };
    },

    /** List workflows for a company */
    async list(companyId: string, opts?: { issueId?: string; status?: string }) {
      const conditions = [eq(workflowRuns.companyId, companyId)];
      if (opts?.issueId) conditions.push(eq(workflowRuns.issueId, opts.issueId));
      if (opts?.status) conditions.push(eq(workflowRuns.status, opts.status));

      return db
        .select()
        .from(workflowRuns)
        .where(and(...conditions))
        .orderBy(desc(workflowRuns.createdAt));
    },

    /** Advance workflow to next step or mark complete */
    async advanceStep(
      workflowId: string,
      stepIndex: number,
      result: { status: "completed" | "failed"; result?: Record<string, unknown>; error?: string },
    ) {
      // Update step run
      await db
        .update(workflowStepRuns)
        .set({
          status: result.status,
          result: result.result ?? null,
          error: result.error ?? null,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(workflowStepRuns.workflowRunId, workflowId),
            eq(workflowStepRuns.stepIndex, stepIndex),
          ),
        );

      // Get workflow to check next step
      const workflow = await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, workflowId))
        .then((rows) => rows[0]);

      if (!workflow) return null;

      const steps = workflow.steps as WorkflowStepDef[];

      if (result.status === "failed") {
        const policy = workflow.onStepFailure;
        if (policy === "abort") {
          await db.update(workflowRuns).set({
            status: "failed",
            error: result.error ?? `Step ${stepIndex} failed`,
            completedAt: new Date(),
            updatedAt: new Date(),
          }).where(eq(workflowRuns.id, workflowId));
          return { action: "aborted" as const };
        }
        if (policy === "pause") {
          await db.update(workflowRuns).set({
            status: "paused",
            error: result.error ?? `Step ${stepIndex} failed — paused for review`,
            updatedAt: new Date(),
          }).where(eq(workflowRuns.id, workflowId));
          return { action: "paused" as const };
        }
        // skip: fall through to advance
      }

      const nextStep = stepIndex + 1;
      if (nextStep >= steps.length) {
        // Workflow complete
        await db.update(workflowRuns).set({
          status: "completed",
          currentStep: nextStep,
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(workflowRuns.id, workflowId));
        return { action: "completed" as const };
      }

      // Advance to next step
      await db.update(workflowRuns).set({
        currentStep: nextStep,
        updatedAt: new Date(),
      }).where(eq(workflowRuns.id, workflowId));

      // Mark next step as running
      await db
        .update(workflowStepRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(
          and(
            eq(workflowStepRuns.workflowRunId, workflowId),
            eq(workflowStepRuns.stepIndex, nextStep),
          ),
        );

      return { action: "advanced" as const, nextStep };
    },

    /** Start a workflow (set first step to running) */
    async start(workflowId: string) {
      await db.update(workflowRuns).set({
        status: "running",
        startedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(workflowRuns.id, workflowId));

      await db
        .update(workflowStepRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(
          and(
            eq(workflowStepRuns.workflowRunId, workflowId),
            eq(workflowStepRuns.stepIndex, 0),
          ),
        );
    },

    /** Cancel a workflow */
    async cancel(workflowId: string) {
      await db.update(workflowRuns).set({
        status: "cancelled",
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(workflowRuns.id, workflowId));
    },
  };
}

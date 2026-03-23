import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns, agents } from "@paperclipai/db";
import { publishLiveEvent } from "./live-events.js";

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

        // Emit meeting.completed for meeting/consensus workflows
        try {
          publishLiveEvent({
            companyId: workflow.companyId,
            type: "meeting.completed",
            payload: { workflowId, name: workflow.name },
          });
        } catch { /* non-fatal */ }

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

    /**
     * Create a meeting workflow — parallel agent execution + synthesis
     * workflow_type = 'meeting'
     */
    async createMeeting(
      companyId: string,
      data: {
        name: string;
        issueId?: string;
        participantAgentIds: string[];
        meetingType: "standup" | "consultation" | "consensus";
        prompt: string;
        createdBy?: string;
      },
    ) {
      // Build steps: one per participant agent + CEO synthesis step
      const participantSteps: WorkflowStepDef[] = data.participantAgentIds.map((agentId) => ({
        adapterType: "claude_local",
        action: "meeting_response",
        prompt: data.prompt,
        config: { agentId, meetingType: data.meetingType },
      }));

      // Add synthesis step (CEO or first agent)
      const synthesisStep: WorkflowStepDef = {
        adapterType: "claude_local",
        action: "meeting_synthesis",
        prompt: `Synthesize the meeting responses from ${data.participantAgentIds.length} participants.`,
        dependsOn: participantSteps.map((_, i) => i),
        config: { meetingType: data.meetingType },
      };

      const steps = [...participantSteps, synthesisStep];

      // Create workflow with workflow_type = 'meeting'
      const [workflow] = await db
        .insert(workflowRuns)
        .values({
          companyId,
          issueId: data.issueId ?? null,
          name: data.name,
          steps,
          createdBy: data.createdBy ?? "system",
          onStepFailure: "skip",
          maxRetries: 1,
          timeoutPerStepMs: 120_000,
        })
        .returning();

      // Set workflow_type via raw SQL (column exists in DB but not in Drizzle schema)
      await db.execute(
        sql`UPDATE workflow_runs SET workflow_type = 'meeting' WHERE id = ${workflow!.id}`,
      );

      // Pre-create step run records
      await db.insert(workflowStepRuns).values(
        steps.map((step, index) => ({
          workflowRunId: workflow!.id,
          stepIndex: index,
          adapterType: step.adapterType,
          prompt: step.prompt ?? null,
        })),
      );

      try {
        publishLiveEvent({
          companyId,
          type: "meeting.started",
          payload: { workflowId: workflow!.id, name: data.name, participantCount: data.participantAgentIds.length },
        });
      } catch { /* non-fatal */ }

      return workflow!;
    },

    /**
     * Create a tri-model consensus workflow
     * Runs same prompt on 3 different adapter types in parallel
     */
    async createConsensus(
      companyId: string,
      data: {
        issueId?: string;
        prompt: string;
        models?: string[];
        createdBy?: string;
      },
    ) {
      const models = data.models ?? ["claude_local", "codex_local", "gemini_local"];
      const steps: WorkflowStepDef[] = models.map((adapterType) => ({
        adapterType,
        action: "consensus_vote",
        prompt: data.prompt,
      }));

      // Synthesis step
      steps.push({
        adapterType: "claude_local",
        action: "consensus_synthesis",
        prompt: `Synthesize ${models.length} model responses into a unified consensus.`,
        dependsOn: models.map((_, i) => i),
      });

      const [workflow] = await db
        .insert(workflowRuns)
        .values({
          companyId,
          issueId: data.issueId ?? null,
          name: `Tri-Model Consensus`,
          steps,
          createdBy: data.createdBy ?? "system",
          onStepFailure: "skip",
        })
        .returning();

      await db.execute(
        sql`UPDATE workflow_runs SET workflow_type = 'consensus' WHERE id = ${workflow!.id}`,
      );

      await db.insert(workflowStepRuns).values(
        steps.map((step, index) => ({
          workflowRunId: workflow!.id,
          stepIndex: index,
          adapterType: step.adapterType,
          prompt: step.prompt ?? null,
        })),
      );

      return workflow!;
    },
  };
}

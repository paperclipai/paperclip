import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  workflows,
  workflowRevisions,
  workflowAgentAssignments,
  workflowRuns,
  workflowRunSteps,
} from "@paperclipai/db";
import type {
  CreateWorkflow,
  UpdateWorkflow,
  CreateWorkflowRun,
  SubmitWorkflowStep,
  WorkflowDetail,
  WorkflowListItem,
  WorkflowRunSummary,
  WorkflowGraph,
  WorkflowStepDef,
  WorkflowEdge,
  WorkflowMermaidOutput,
} from "@paperclipai/shared";
import { notFound, conflict, unprocessable } from "../errors.js";

type Actor = { agentId?: string | null; userId?: string | null };

/* ------------------------------------------------------------------ */
/*  Definition compiler: YAML → WorkflowGraph                         */
/* ------------------------------------------------------------------ */

/**
 * Minimal YAML-like parser for workflow definitions.
 * Accepts JSON or a simple key-value structure.
 * Full YAML support can be added later via a proper parser library.
 */
function compileDefinition(yamlString: string): WorkflowGraph {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(yamlString) as Record<string, unknown>;
  } catch {
    throw unprocessable("definitionYaml must be valid JSON (full YAML parsing will be added in a future revision)");
  }

  const rawSteps = raw.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw unprocessable("Definition must include a non-empty 'steps' array");
  }

  const steps: WorkflowStepDef[] = rawSteps.map((s: Record<string, unknown>) => {
    if (!s.key || typeof s.key !== "string") throw unprocessable("Each step must have a string 'key'");
    if (!s.name || typeof s.name !== "string") throw unprocessable("Each step must have a string 'name'");
    return {
      key: s.key as string,
      name: s.name as string,
      description: (s.description as string) ?? undefined,
      type: (s.type as string) ?? "action",
      validationSchema: s.validationSchema as Record<string, unknown> | undefined,
      childWorkflowId: (s.childWorkflowId as string) ?? undefined,
      metadata: s.metadata as Record<string, unknown> | undefined,
    };
  });

  const rawEdges = (raw.edges ?? []) as Array<Record<string, unknown>>;
  const edges: WorkflowEdge[] = rawEdges.map((e) => ({
    from: e.from as string,
    to: e.to as string,
    condition: (e.condition as string) ?? undefined,
  }));

  const entryStepKey = (raw.entryStepKey as string) ?? steps[0].key;

  return { steps, edges, entryStepKey };
}

/* ------------------------------------------------------------------ */
/*  Mermaid generation                                                 */
/* ------------------------------------------------------------------ */

function graphToMermaid(graph: WorkflowGraph, title: string, activeStepKey?: string | null): string {
  const lines: string[] = ["flowchart TD"];

  for (const step of graph.steps) {
    const label = step.name.replace(/"/g, "'");
    if (step.key === activeStepKey) {
      lines.push(`  ${step.key}["${label}"]:::active`);
    } else {
      lines.push(`  ${step.key}["${label}"]`);
    }
  }

  if (graph.edges.length > 0) {
    for (const edge of graph.edges) {
      if (edge.condition) {
        lines.push(`  ${edge.from} -->|${edge.condition}| ${edge.to}`);
      } else {
        lines.push(`  ${edge.from} --> ${edge.to}`);
      }
    }
  } else {
    // Auto-generate linear edges from step order
    for (let i = 0; i < graph.steps.length - 1; i++) {
      lines.push(`  ${graph.steps[i].key} --> ${graph.steps[i + 1].key}`);
    }
  }

  if (activeStepKey) {
    lines.push("  classDef active fill:#22c55e,stroke:#16a34a,color:#fff");
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

const ACTIVE_RUN_STATUSES = ["pending", "running", "waiting_input"];

export function workflowService(db: Db) {
  /* ---------- helpers ---------- */

  async function getWorkflowOrThrow(id: string) {
    const row = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, id))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound("Workflow not found");
    return row;
  }

  async function getRunOrThrow(id: string) {
    const row = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, id))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound("Workflow run not found");
    return row;
  }

  function buildRunSummary(row: typeof workflowRuns.$inferSelect): WorkflowRunSummary {
    return {
      id: row.id,
      status: row.status,
      currentStepKey: row.currentStepKey,
      stepIndex: row.stepIndex,
      agentId: row.agentId,
      triggerSource: row.triggerSource,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
    };
  }

  /* ---------- definition CRUD ---------- */

  return {
    list: async (companyId: string): Promise<WorkflowListItem[]> => {
      const rows = await db.select().from(workflows).where(eq(workflows.companyId, companyId));

      const items: WorkflowListItem[] = [];
      for (const row of rows) {
        const [assignmentRows] = await db
          .select({ count: count() })
          .from(workflowAgentAssignments)
          .where(eq(workflowAgentAssignments.workflowId, row.id));

        const lastRunRow = await db
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.workflowId, row.id))
          .orderBy(desc(workflowRuns.createdAt))
          .limit(1)
          .then((r) => r[0] ?? null);

        const [activeRunRows] = await db
          .select({ count: count() })
          .from(workflowRuns)
          .where(
            and(eq(workflowRuns.workflowId, row.id), inArray(workflowRuns.status, ACTIVE_RUN_STATUSES)),
          );

        items.push({
          ...row,
          assignmentCount: Number(assignmentRows.count),
          lastRun: lastRunRow ? buildRunSummary(lastRunRow) : null,
          activeRunCount: Number(activeRunRows.count),
        });
      }

      return items;
    },

    getDetail: async (id: string): Promise<WorkflowDetail> => {
      const row = await getWorkflowOrThrow(id);

      const assignmentRows = await db
        .select({
          id: agents.id,
          name: agents.name,
          role: agents.role,
          title: agents.title,
          icon: agents.icon,
        })
        .from(workflowAgentAssignments)
        .innerJoin(agents, eq(workflowAgentAssignments.agentId, agents.id))
        .where(eq(workflowAgentAssignments.workflowId, id));

      const recentRuns = await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.workflowId, id))
        .orderBy(desc(workflowRuns.createdAt))
        .limit(10)
        .then((r) => r.map(buildRunSummary));

      let compiledGraph: WorkflowGraph | null = null;
      if (row.definitionCompiled) {
        compiledGraph = row.definitionCompiled as unknown as WorkflowGraph;
      }

      return {
        ...row,
        assignments: assignmentRows,
        recentRuns,
        compiledGraph,
      };
    },

    create: async (companyId: string, input: CreateWorkflow, actor: Actor) => {
      const compiled = compileDefinition(input.definitionYaml);

      const [existing] = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.companyId, companyId), eq(workflows.slug, input.slug)));
      if (existing) throw conflict(`Workflow with slug '${input.slug}' already exists in this company`);

      const [row] = await db
        .insert(workflows)
        .values({
          companyId,
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          definitionYaml: input.definitionYaml,
          definitionCompiled: compiled as unknown as Record<string, unknown>,
          assigneeAgentId: input.assigneeAgentId ?? null,
          status: input.status ?? "draft",
          metadata: input.metadata ?? null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning();

      // Create revision v1
      await db.insert(workflowRevisions).values({
        workflowId: row.id,
        version: 1,
        definitionYaml: input.definitionYaml,
        definitionCompiled: compiled as unknown as Record<string, unknown>,
        changeSummary: "Initial version",
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      });

      return row;
    },

    update: async (id: string, input: UpdateWorkflow, actor: Actor) => {
      const existing = await getWorkflowOrThrow(id);
      let compiled = existing.definitionCompiled;
      let newVersion = existing.version;

      if (input.definitionYaml && input.definitionYaml !== existing.definitionYaml) {
        compiled = compileDefinition(input.definitionYaml) as unknown as Record<string, unknown>;
        newVersion = existing.version + 1;

        await db.insert(workflowRevisions).values({
          workflowId: id,
          version: newVersion,
          definitionYaml: input.definitionYaml,
          definitionCompiled: compiled,
          changeSummary: null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        });
      }

      const [row] = await db
        .update(workflows)
        .set({
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description ?? null } : {}),
          ...(input.definitionYaml !== undefined
            ? { definitionYaml: input.definitionYaml, definitionCompiled: compiled }
            : {}),
          ...(input.assigneeAgentId !== undefined ? { assigneeAgentId: input.assigneeAgentId ?? null } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata ?? null } : {}),
          version: newVersion,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, id))
        .returning();

      return row;
    },

    archive: async (id: string, actor: Actor) => {
      await getWorkflowOrThrow(id);

      const [row] = await db
        .update(workflows)
        .set({
          status: "archived",
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, id))
        .returning();

      return row;
    },

    listRevisions: async (workflowId: string) => {
      await getWorkflowOrThrow(workflowId);
      return db
        .select()
        .from(workflowRevisions)
        .where(eq(workflowRevisions.workflowId, workflowId))
        .orderBy(desc(workflowRevisions.version));
    },

    /* ---------- assignments ---------- */

    listAssignments: async (workflowId: string) => {
      await getWorkflowOrThrow(workflowId);
      return db
        .select({
          id: workflowAgentAssignments.id,
          agentId: agents.id,
          name: agents.name,
          role: agents.role,
          title: agents.title,
          icon: agents.icon,
          createdAt: workflowAgentAssignments.createdAt,
        })
        .from(workflowAgentAssignments)
        .innerJoin(agents, eq(workflowAgentAssignments.agentId, agents.id))
        .where(eq(workflowAgentAssignments.workflowId, workflowId));
    },

    assign: async (workflowId: string, agentId: string, companyId: string, actor: Actor) => {
      await getWorkflowOrThrow(workflowId);

      const [existing] = await db
        .select({ id: workflowAgentAssignments.id })
        .from(workflowAgentAssignments)
        .where(
          and(
            eq(workflowAgentAssignments.workflowId, workflowId),
            eq(workflowAgentAssignments.agentId, agentId),
          ),
        );
      if (existing) throw conflict("Agent is already assigned to this workflow");

      const [row] = await db
        .insert(workflowAgentAssignments)
        .values({
          companyId,
          workflowId,
          agentId,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning();

      return row;
    },

    unassign: async (assignmentId: string) => {
      const [row] = await db
        .delete(workflowAgentAssignments)
        .where(eq(workflowAgentAssignments.id, assignmentId))
        .returning();
      if (!row) throw notFound("Assignment not found");
      return row;
    },

    listAgentWorkflows: async (companyId: string, agentId: string) => {
      return db
        .select({
          assignment: workflowAgentAssignments,
          workflow: workflows,
        })
        .from(workflowAgentAssignments)
        .innerJoin(workflows, eq(workflowAgentAssignments.workflowId, workflows.id))
        .where(
          and(
            eq(workflowAgentAssignments.companyId, companyId),
            eq(workflowAgentAssignments.agentId, agentId),
          ),
        )
        .then((rows) => rows.map((r) => r.workflow));
    },

    /* ---------- runtime: runs + steps ---------- */

    createRun: async (companyId: string, input: CreateWorkflowRun, actor: Actor) => {
      const workflow = await getWorkflowOrThrow(input.workflowId);
      if (workflow.status !== "active") {
        throw unprocessable("Cannot create a run for a workflow that is not active");
      }

      const graph = workflow.definitionCompiled as unknown as WorkflowGraph | null;
      if (!graph) throw unprocessable("Workflow definition is not compiled");

      const agentId = input.agentId ?? workflow.assigneeAgentId;
      if (!agentId) throw unprocessable("No agent specified and workflow has no default assignee");

      const [run] = await db
        .insert(workflowRuns)
        .values({
          companyId,
          workflowId: input.workflowId,
          workflowVersion: workflow.version,
          agentId,
          status: "running",
          currentStepKey: graph.entryStepKey,
          stepIndex: 0,
          linkedIssueId: input.linkedIssueId ?? null,
          stateJson: input.initialStateJson ?? null,
          triggerSource: input.triggerSource ?? "api",
          startedAt: new Date(),
        })
        .returning();

      // Create the first step record
      await db.insert(workflowRunSteps).values({
        runId: run.id,
        stepKey: graph.entryStepKey,
        stepIndex: 0,
        status: "active",
        startedAt: new Date(),
      });

      return run;
    },

    getCurrentStep: async (runId: string) => {
      const run = await getRunOrThrow(runId);
      if (!run.currentStepKey) return null;

      const step = await db
        .select()
        .from(workflowRunSteps)
        .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.stepKey, run.currentStepKey)))
        .orderBy(desc(workflowRunSteps.stepIndex))
        .limit(1)
        .then((r) => r[0] ?? null);

      return step;
    },

    submitStep: async (runId: string, input: SubmitWorkflowStep) => {
      const run = await getRunOrThrow(runId);
      if (!["running", "waiting_input"].includes(run.status)) {
        throw unprocessable(`Cannot submit step for run in status '${run.status}'`);
      }
      if (!run.currentStepKey) {
        throw unprocessable("Run has no current step");
      }

      const workflow = await getWorkflowOrThrow(run.workflowId);
      const graph = workflow.definitionCompiled as unknown as WorkflowGraph | null;
      if (!graph) throw unprocessable("Workflow graph not available");

      // Mark current step as submitted/accepted
      await db
        .update(workflowRunSteps)
        .set({
          status: "accepted",
          submissionJson: input.submissionJson,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workflowRunSteps.runId, runId),
            eq(workflowRunSteps.stepKey, run.currentStepKey),
            eq(workflowRunSteps.status, "active"),
          ),
        );

      // Find next step via edges, or linear sequence
      let nextStepKey: string | null = null;
      if (graph.edges.length > 0) {
        const outEdge = graph.edges.find((e: WorkflowEdge) => e.from === run.currentStepKey);
        nextStepKey = outEdge?.to ?? null;
      } else {
        const currentIdx = graph.steps.findIndex((s: WorkflowStepDef) => s.key === run.currentStepKey);
        if (currentIdx >= 0 && currentIdx < graph.steps.length - 1) {
          nextStepKey = graph.steps[currentIdx + 1].key;
        }
      }

      if (nextStepKey) {
        // Advance to next step
        const newStepIndex = run.stepIndex + 1;

        await db.insert(workflowRunSteps).values({
          runId,
          stepKey: nextStepKey,
          stepIndex: newStepIndex,
          status: "active",
          startedAt: new Date(),
        });

        const [updatedRun] = await db
          .update(workflowRuns)
          .set({
            currentStepKey: nextStepKey,
            stepIndex: newStepIndex,
            status: "running",
            stateJson: {
              ...(run.stateJson ?? {}),
              [run.currentStepKey]: input.submissionJson,
            },
            updatedAt: new Date(),
          })
          .where(eq(workflowRuns.id, runId))
          .returning();

        return updatedRun;
      } else {
        // No next step — workflow completed
        const [updatedRun] = await db
          .update(workflowRuns)
          .set({
            currentStepKey: null,
            status: "completed",
            resultJson: input.submissionJson,
            stateJson: {
              ...(run.stateJson ?? {}),
              [run.currentStepKey]: input.submissionJson,
            },
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(workflowRuns.id, runId))
          .returning();

        return updatedRun;
      }
    },

    getRunStatus: async (runId: string) => {
      const run = await getRunOrThrow(runId);
      const steps = await db
        .select()
        .from(workflowRunSteps)
        .where(eq(workflowRunSteps.runId, runId))
        .orderBy(workflowRunSteps.stepIndex);
      return { ...run, steps };
    },

    cancelRun: async (runId: string, reason?: string) => {
      const run = await getRunOrThrow(runId);
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        throw unprocessable(`Cannot cancel a run in status '${run.status}'`);
      }

      const [row] = await db
        .update(workflowRuns)
        .set({
          status: "cancelled",
          error: reason ?? "Cancelled",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(workflowRuns.id, runId))
        .returning();

      return row;
    },

    listRuns: async (workflowId: string) => {
      return db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.workflowId, workflowId))
        .orderBy(desc(workflowRuns.createdAt));
    },

    listRunSteps: async (runId: string) => {
      await getRunOrThrow(runId);
      return db
        .select()
        .from(workflowRunSteps)
        .where(eq(workflowRunSteps.runId, runId))
        .orderBy(workflowRunSteps.stepIndex);
    },

    /* ---------- Mermaid ---------- */

    generateMermaid: async (workflowId: string): Promise<WorkflowMermaidOutput> => {
      const workflow = await getWorkflowOrThrow(workflowId);
      const graph = workflow.definitionCompiled as unknown as WorkflowGraph | null;
      if (!graph) throw unprocessable("Workflow definition is not compiled");
      return {
        mermaid: graphToMermaid(graph, workflow.name),
        title: workflow.name,
      };
    },

    generateRunMermaid: async (runId: string): Promise<WorkflowMermaidOutput> => {
      const run = await getRunOrThrow(runId);
      const workflow = await getWorkflowOrThrow(run.workflowId);
      const graph = workflow.definitionCompiled as unknown as WorkflowGraph | null;
      if (!graph) throw unprocessable("Workflow definition is not compiled");
      return {
        mermaid: graphToMermaid(graph, workflow.name, run.currentStepKey),
        title: `${workflow.name} — Run ${run.id.slice(0, 8)}`,
      };
    },

    /* ---------- compiler (exposed for validation routes) ---------- */

    compileDefinition,
    validateDefinition: (yamlString: string) => {
      compileDefinition(yamlString);
      return { valid: true };
    },
  };
}

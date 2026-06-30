import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWorkflowRuns, agentWorkflows, agents } from "@paperclipai/db";
import {
  AI_FACTORY_ORG_TEMPLATE,
  getConnectorAction,
  getWorkflowTemplate,
  type FactoryAgentCreateInput,
  type FactoryAgentSummary,
  type WorkflowStep,
  type WorkflowStepRunResult,
  type WorkflowCreateInput,
  type WorkflowUpdateInput,
} from "@paperclipai/shared";
import { issueService } from "./issues.js";
import { heartbeatService } from "./heartbeat.js";
import { integratorsService, type IntegratorAgentTool } from "./integrators.js";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";

/** Render the connected-integrator tool catalog as agent-readable guidance. */
function integratorToolsSection(tools: IntegratorAgentTool[]): string[] {
  if (tools.length === 0) return [];
  const lines = [
    ``,
    `## Integrator tools available to you`,
    `Each tool below is a real, authenticated API call. To invoke one, call the`,
    `Paperclip API (use the \`paperclip\` skill) — credentials are injected server-side,`,
    `so you never handle secrets:`,
    ``,
  ];
  for (const tool of tools) {
    lines.push(`- \`${tool.name}\` — ${tool.description} (${tool.system})`);
    lines.push(`  - ${tool.endpoint}`);
    lines.push(`  - body: ${JSON.stringify(tool.body)}`);
  }
  return lines;
}

/** Build the task body an assigned agent reads to perform a workflow step. */
function stepIssueBody(step: WorkflowStep, tools: IntegratorAgentTool[] = []): string {
  const action = getConnectorAction(step.connector, step.action);
  const lines = [
    `Workflow step run by the AI Factory.`,
    ``,
    `- Integrator: ${step.connector}`,
    `- Action: ${step.action}${action ? ` (${action.label})` : ""}`,
  ];
  if (action?.description) lines.push(`- Goal: ${action.description}`);
  if (step.config && Object.keys(step.config).length > 0) {
    lines.push(`- Inputs: ${JSON.stringify(step.config)}`);
  }
  lines.push(...integratorToolsSection(tools));
  return lines.join("\n");
}

/** Map an agent domain to the closest built-in agent role. */
const DOMAIN_ROLE: Record<string, string> = {
  it: "devops",
  hr: "general",
  finance: "cfo",
  procurement: "general",
  general: "general",
};

type Actor = { agentId?: string | null; userId?: string | null };

function normalizeSteps(steps: WorkflowStep[] | undefined): WorkflowStep[] {
  return (steps ?? []).map((s) => ({
    ...s,
    assigneeAgentId: s.assigneeAgentId ?? null,
    config: s.config ?? {},
  }));
}

export function agentsStudioService(db: Db) {
  return {
    listConnectors() {
      // Static catalog lives in shared; exposed for the studio palette.
      return undefined;
    },

    list: (companyId: string) =>
      db
        .select()
        .from(agentWorkflows)
        .where(eq(agentWorkflows.companyId, companyId))
        .orderBy(desc(agentWorkflows.updatedAt)),

    getById: (companyId: string, id: string) =>
      db
        .select()
        .from(agentWorkflows)
        .where(and(eq(agentWorkflows.companyId, companyId), eq(agentWorkflows.id, id)))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: WorkflowCreateInput, actor: Actor) =>
      db
        .insert(agentWorkflows)
        .values({
          companyId,
          name: data.name,
          description: data.description ?? null,
          status: data.status ?? "draft",
          steps: normalizeSteps(data.steps),
          templateKey: data.templateKey ?? null,
          tags: data.tags ?? [],
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]!),

    async update(companyId: string, id: string, data: WorkflowUpdateInput) {
      const patch: Partial<typeof agentWorkflows.$inferInsert> = { updatedAt: new Date() };
      if (data.name !== undefined) patch.name = data.name;
      if (data.description !== undefined) patch.description = data.description ?? null;
      if (data.status !== undefined) patch.status = data.status;
      if (data.steps !== undefined) patch.steps = normalizeSteps(data.steps);
      if (data.templateKey !== undefined) patch.templateKey = data.templateKey ?? null;
      if (data.tags !== undefined) patch.tags = data.tags;
      return db
        .update(agentWorkflows)
        .set(patch)
        .where(and(eq(agentWorkflows.companyId, companyId), eq(agentWorkflows.id, id)))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: (companyId: string, id: string) =>
      db
        .delete(agentWorkflows)
        .where(and(eq(agentWorkflows.companyId, companyId), eq(agentWorkflows.id, id)))
        .returning()
        .then((rows) => rows[0] ?? null),

    deployTemplate(companyId: string, templateKey: string, name: string | undefined, actor: Actor) {
      const template = getWorkflowTemplate(templateKey);
      if (!template) return null;
      const steps: WorkflowStep[] = template.steps.map((s) => ({ ...s, assigneeAgentId: null }));
      return db
        .insert(agentWorkflows)
        .values({
          companyId,
          name: name ?? template.name,
          description: template.description,
          status: "active",
          steps,
          templateKey: template.key,
          tags: template.tags,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]!);
    },

    /**
     * Idempotently provision the AI Factory agent org for a company. Each
     * template member is tagged with metadata.factoryKey so re-running only
     * creates the members that are missing. The factory root attaches under an
     * existing company root agent if there is one, otherwise becomes a root.
     */
    async provisionOrg(companyId: string) {
      const existing = await db.select().from(agents).where(eq(agents.companyId, companyId));
      const byFactoryKey = new Map<string, (typeof existing)[number]>();
      for (const a of existing) {
        const key = (a.metadata as Record<string, unknown> | null)?.factoryKey;
        if (typeof key === "string") byFactoryKey.set(key, a);
      }

      // Attach the factory under an existing root (reportsTo === null) if present.
      const existingRoot = existing.find((a) => a.reportsTo === null) ?? null;

      const created: { key: string; id: string; name: string }[] = [];
      const idByKey = new Map<string, string>();
      for (const [key, agent] of byFactoryKey) idByKey.set(key, agent.id);

      // Insert in template order so parents exist before children.
      for (const member of AI_FACTORY_ORG_TEMPLATE) {
        if (byFactoryKey.has(member.key)) {
          idByKey.set(member.key, byFactoryKey.get(member.key)!.id);
          continue;
        }
        const reportsTo = member.reportsToKey
          ? idByKey.get(member.reportsToKey) ?? null
          : existingRoot?.id ?? null;
        const inserted = await db
          .insert(agents)
          .values({
            companyId,
            name: member.name,
            role: member.role,
            title: member.title,
            reportsTo,
            capabilities: member.capabilities,
            adapterType: "claude_local",
            status: "idle",
            metadata: { factoryKey: member.key, aiFactory: true, connector: member.connector },
          })
          .returning()
          .then((rows) => rows[0]!);
        idByKey.set(member.key, inserted.id);
        created.push({ key: member.key, id: inserted.id, name: inserted.name });
      }

      return {
        created,
        createdCount: created.length,
        skippedCount: AI_FACTORY_ORG_TEMPLATE.length - created.length,
        totalMembers: AI_FACTORY_ORG_TEMPLATE.length,
      };
    },

    /** Agents available to assign to workflow steps (factory-built first). */
    async listFactoryAgents(companyId: string): Promise<FactoryAgentSummary[]> {
      const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
      return rows
        .map((a) => {
          const meta = (a.metadata as Record<string, unknown> | null) ?? {};
          return {
            id: a.id,
            name: a.name,
            title: a.title,
            role: a.role,
            domain: typeof meta.domain === "string" ? meta.domain : null,
            allowedIntegrators: Array.isArray(meta.allowedIntegrators)
              ? (meta.allowedIntegrators as string[])
              : [],
            isFactoryBuilt: meta.aiFactoryAgent === true || meta.aiFactory === true,
          };
        })
        .sort((a, b) => Number(b.isFactoryBuilt) - Number(a.isFactoryBuilt) || a.name.localeCompare(b.name));
    },

    /** Create a specialized agent in the factory org (Agent Studio "Create Agent"). */
    async createFactoryAgent(companyId: string, input: FactoryAgentCreateInput) {
      const existing = await db.select().from(agents).where(eq(agents.companyId, companyId));
      const director = existing.find(
        (a) => (a.metadata as Record<string, unknown> | null)?.factoryKey === "director",
      );
      const root = existing.find((a) => a.reportsTo === null) ?? null;
      const reportsTo = director?.id ?? root?.id ?? null;
      const inserted = await db
        .insert(agents)
        .values({
          companyId,
          name: input.name,
          role: DOMAIN_ROLE[input.domain] ?? "general",
          title: `${input.domain.toUpperCase()} Agent`,
          reportsTo,
          capabilities: input.instructions || null,
          adapterType: "claude_local",
          status: "idle",
          metadata: {
            aiFactoryAgent: true,
            domain: input.domain,
            allowedIntegrators: input.allowedIntegrators,
          },
        })
        .returning()
        .then((rows) => rows[0]!);
      return inserted;
    },

    listRuns: (companyId: string, workflowId: string) =>
      db
        .select()
        .from(agentWorkflowRuns)
        .where(and(eq(agentWorkflowRuns.companyId, companyId), eq(agentWorkflowRuns.workflowId, workflowId)))
        .orderBy(desc(agentWorkflowRuns.createdAt)),

    /**
     * Run a workflow on the real Paperclip engine. Creates a parent issue plus
     * one child issue per step (assigned to the step's agent) and wakes each
     * assignee — the same issue + heartbeat path Routines use. The assigned
     * agents then execute the work for real via their adapters.
     */
    async run(
      companyId: string,
      workflowId: string,
      trigger: string,
      deps?: { pluginWorkerManager?: unknown },
    ) {
      const workflow = await db
        .select()
        .from(agentWorkflows)
        .where(and(eq(agentWorkflows.companyId, companyId), eq(agentWorkflows.id, workflowId)))
        .then((rows) => rows[0] ?? null);
      if (!workflow) return null;

      const issues = issueService(db);
      const heartbeat = heartbeatService(db, {
        pluginWorkerManager: deps?.pluginWorkerManager as never,
      });
      // Surface the connected-integrator tool catalog to every step so assigned
      // agents can call real APIs autonomously while executing the work.
      const integratorTools = await integratorsService(db).toolsCatalog(companyId).catch(() => []);

      const parent = await issues.create(companyId, {
        title: `Workflow: ${workflow.name}`,
        description: `Created by Agents Studio to run the "${workflow.name}" workflow on the AI Factory.`,
        status: "todo",
        priority: "medium",
        originKind: "ai_factory_workflow",
        originId: workflow.id,
      });

      const stepResults: WorkflowStepRunResult[] = [];
      for (const step of workflow.steps ?? []) {
        let status: WorkflowStepRunResult["status"] = "running";
        let detail = "";
        try {
          // Try assigned create first; fall back to unassigned if the agent
          // isn't currently work-eligible so the task still lands on the board.
          let child;
          try {
            child = await issues.create(companyId, {
              parentId: parent.id,
              title: step.name,
              description: stepIssueBody(step, integratorTools),
              status: "todo",
              priority: "medium",
              assigneeAgentId: step.assigneeAgentId ?? null,
              originKind: "ai_factory_workflow_step",
              originId: workflow.id,
            });
          } catch {
            child = await issues.create(companyId, {
              parentId: parent.id,
              title: step.name,
              description: stepIssueBody(step, integratorTools),
              status: "todo",
              priority: "medium",
              originKind: "ai_factory_workflow_step",
              originId: workflow.id,
            });
          }
          const ref = (child as { identifier?: string | null }).identifier ?? child.id;
          if (child.assigneeAgentId) {
            await queueIssueAssignmentWakeup({
              heartbeat,
              issue: { id: child.id, assigneeAgentId: child.assigneeAgentId, status: child.status },
              reason: "ai_factory_workflow",
              mutation: "create",
              contextSource: "agents-studio.run",
              requestedByActorType: "system",
            });
            detail = `Task ${ref} created and assignee woken to execute.`;
          } else {
            status = "pending";
            detail = `Task ${ref} created (unassigned — assign an agent to run it).`;
          }
        } catch (err) {
          status = "failed";
          detail = `Failed to create task: ${(err as Error).message}`;
        }
        stepResults.push({
          stepId: step.id,
          name: step.name,
          connector: step.connector,
          action: step.action,
          status,
          detail,
        });
      }

      const anyFailed = stepResults.some((r) => r.status === "failed");
      return db
        .insert(agentWorkflowRuns)
        .values({
          companyId,
          workflowId,
          status: anyFailed ? "failed" : "running",
          trigger,
          stepResults,
          startedAt: new Date(),
          finishedAt: anyFailed ? new Date() : null,
        })
        .returning()
        .then((rows) => rows[0]!);
    },
  };
}

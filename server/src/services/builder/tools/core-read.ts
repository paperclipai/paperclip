import type { Db } from "@paperclipai/db";
import { redactEventPayload } from "../../../redaction.js";
import {
  activityService,
  agentService,
  approvalService,
  budgetService,
  companyService,
  goalService,
  inviteService,
  issueService,
  projectService,
  routineService,
} from "../../index.js";
import type { BuilderTool, BuilderToolRunContext, BuilderToolRunResult } from "../types.js";

const LIST_RESULT_LIMIT = 50;

function ok(result: unknown): BuilderToolRunResult {
  return { ok: true, result };
}

function summarizeAgent(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    title: row.title ?? null,
    status: row.status,
    adapterType: row.adapterType,
    reportsTo: row.reportsTo ?? null,
  };
}

function summarizeGoal(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    level: row.level,
    status: row.status,
    parentId: row.parentId ?? null,
    ownerAgentId: row.ownerAgentId ?? null,
  };
}

function summarizeRoutine(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeAgentId: row.assigneeAgentId ?? null,
    projectId: row.projectId ?? null,
  };
}

function summarizeIssue(row: Record<string, unknown>) {
  return {
    id: row.id,
    identifier: row.identifier ?? null,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeAgentId: row.assigneeAgentId ?? null,
    projectId: row.projectId ?? null,
  };
}

function summarizeProject(row: Record<string, unknown>) {
  return {
    id: row.id,
    urlKey: row.urlKey ?? null,
    name: row.name,
    status: row.status,
    leadAgentId: row.leadAgentId ?? null,
    goalIds: Array.isArray(row.goalIds) ? row.goalIds : [],
    archivedAt: row.archivedAt ?? null,
  };
}

function summarizeApproval(row: Record<string, unknown>) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    requestedByAgentId: row.requestedByAgentId ?? null,
    requestedByUserId: row.requestedByUserId ?? null,
    decisionNote: row.decisionNote ?? null,
    decidedByUserId: row.decidedByUserId ?? null,
    decidedAt: row.decidedAt ?? null,
    payload: redactEventPayload((row.payload as Record<string, unknown> | null) ?? null) ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function clampListLimit(input: unknown, fallback = LIST_RESULT_LIMIT) {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  return Math.max(1, Math.min(Math.floor(input), LIST_RESULT_LIMIT));
}

async function resolveAgentForCompany(db: Db, companyId: string, reference: string) {
  const agents = agentService(db);
  const resolved = await agents.resolveByReference(companyId, reference);
  if (resolved.ambiguous) throw new Error("Agent reference is ambiguous");
  return resolved.agent;
}

async function resolveProjectForCompany(db: Db, companyId: string, reference: string) {
  const projects = projectService(db);
  const resolved = await projects.resolveByReference(companyId, reference);
  if (resolved.ambiguous) throw new Error("Project reference is ambiguous");
  return resolved.project;
}

export function buildCoreReadOnlyTools(db: Db): BuilderTool[] {
  const companies = companyService(db);
  const agents = agentService(db);
  const goals = goalService(db);
  const routines = routineService(db);
  const issues = issueService(db);
  const budgets = budgetService(db);
  const projects = projectService(db);
  const approvals = approvalService(db);
  const activity = activityService(db);
  const invites = inviteService(db);

  return [
    {
      name: "get_company",
      description:
        "Get high-level metadata about the current company: name, status, monthly budget, and counters.",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      capability: "companies.read",
      source: "core",
      async run(_params, ctx: BuilderToolRunContext) {
        const row = await companies.getById(ctx.companyId);
        if (!row) return { ok: false, error: "Company not found" };
        return ok({
          id: row.id,
          name: row.name,
          description: row.description ?? null,
          status: row.status,
          budgetMonthlyCents: row.budgetMonthlyCents,
          spentMonthlyCents: row.spentMonthlyCents,
        });
      },
    },
    {
      name: "list_agents",
      description:
        "List agents in this company. Returns up to 50 agents with role, status, adapter type, and reporting line.",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      capability: "agents.read",
      source: "core",
      async run(_params, ctx) {
        const rows = await agents.list(ctx.companyId);
        return ok({
          total: rows.length,
          agents: rows.slice(0, LIST_RESULT_LIMIT).map((row) => summarizeAgent(row as unknown as Record<string, unknown>)),
        });
      },
    },
    {
      name: "get_agent",
      description: "Get one agent by UUID or company-scoped short reference, including chain of command.",
      parametersSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
        },
        required: ["agentId"],
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "agents.read",
      source: "core",
      async run(params, ctx) {
        const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
        if (!agentId) return { ok: false, error: "agentId is required" };
        const row = await resolveAgentForCompany(db, ctx.companyId, agentId);
        if (!row || row.companyId !== ctx.companyId) return { ok: false, error: "Agent not found" };
        const chainOfCommand = await agents.getChainOfCommand(row.id);
        return ok({
          ...row,
          chainOfCommand,
        });
      },
    },
    {
      name: "list_projects",
      description: "List projects in this company. Returns up to 50 projects with status, goals, and lead agent.",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      capability: "projects.read",
      source: "core",
      async run(_params, ctx) {
        const rows = await projects.list(ctx.companyId);
        return ok({
          total: rows.length,
          projects: rows.slice(0, LIST_RESULT_LIMIT).map((row) => summarizeProject(row as unknown as Record<string, unknown>)),
        });
      },
    },
    {
      name: "get_project",
      description: "Get a single project by UUID or company-scoped short reference.",
      parametersSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "projects.read",
      source: "core",
      async run(params, ctx) {
        const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
        if (!projectId) return { ok: false, error: "projectId is required" };
        const row = await resolveProjectForCompany(db, ctx.companyId, projectId);
        if (!row || row.companyId !== ctx.companyId) return { ok: false, error: "Project not found" };
        return ok(row);
      },
    },
    {
      name: "list_goals",
      description: "List goals in this company. Returns up to 50 goals with level, status, and parent.",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      capability: "goals.read",
      source: "core",
      async run(_params, ctx) {
        const rows = await goals.list(ctx.companyId);
        return ok({
          total: rows.length,
          goals: rows.slice(0, LIST_RESULT_LIMIT).map((row) => summarizeGoal(row as unknown as Record<string, unknown>)),
        });
      },
    },
    {
      name: "get_goal",
      description: "Get a single goal by id.",
      parametersSchema: {
        type: "object",
        properties: {
          goalId: { type: "string" },
        },
        required: ["goalId"],
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "goals.read",
      source: "core",
      async run(params, ctx) {
        const goalId = typeof params.goalId === "string" ? params.goalId.trim() : "";
        if (!goalId) return { ok: false, error: "goalId is required" };
        const row = await goals.getById(goalId);
        if (!row || row.companyId !== ctx.companyId) return { ok: false, error: "Goal not found" };
        return ok(row);
      },
    },
    {
      name: "list_routines",
      description:
        "List routines in this company. Returns up to 50 routines with status, priority, assignee, and trigger summaries.",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      capability: "routines.read",
      source: "core",
      async run(_params, ctx) {
        const rows = await routines.list(ctx.companyId);
        return ok({
          total: rows.length,
          routines: rows.slice(0, LIST_RESULT_LIMIT).map((row) => summarizeRoutine(row as unknown as Record<string, unknown>)),
        });
      },
    },
    {
      name: "get_routine",
      description:
        "Get a single routine detail, including trigger summaries, recent runs, and active issue context.",
      parametersSchema: {
        type: "object",
        properties: {
          routineId: { type: "string" },
        },
        required: ["routineId"],
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "routines.read",
      source: "core",
      async run(params, ctx) {
        const routineId = typeof params.routineId === "string" ? params.routineId.trim() : "";
        if (!routineId) return { ok: false, error: "routineId is required" };
        const row = await routines.getDetail(routineId);
        if (!row || row.companyId !== ctx.companyId) return { ok: false, error: "Routine not found" };
        return ok(row);
      },
    },
    {
      name: "list_routine_triggers",
      description: "List trigger definitions for a routine.",
      parametersSchema: {
        type: "object",
        properties: {
          routineId: { type: "string" },
        },
        required: ["routineId"],
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "routines.read",
      source: "core",
      async run(params, ctx) {
        const routineId = typeof params.routineId === "string" ? params.routineId.trim() : "";
        if (!routineId) return { ok: false, error: "routineId is required" };
        const row = await routines.getDetail(routineId);
        if (!row || row.companyId !== ctx.companyId) return { ok: false, error: "Routine not found" };
        return ok({
          routineId: row.id,
          total: row.triggers.length,
          triggers: row.triggers,
        });
      },
    },
    {
      name: "get_routine_trigger",
      description: "Get a single routine trigger by id.",
      parametersSchema: {
        type: "object",
        properties: {
          triggerId: { type: "string" },
        },
        required: ["triggerId"],
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "routines.read",
      source: "core",
      async run(params, ctx) {
        const triggerId = typeof params.triggerId === "string" ? params.triggerId.trim() : "";
        if (!triggerId) return { ok: false, error: "triggerId is required" };
        const row = await routines.getTrigger(triggerId);
        if (!row || row.companyId !== ctx.companyId) return { ok: false, error: "Routine trigger not found" };
        return ok(row);
      },
    },
    {
      name: "list_routine_runs",
      description: "List recent runs for a routine.",
      parametersSchema: {
        type: "object",
        properties: {
          routineId: { type: "string" },
          limit: { type: "number" },
        },
        required: ["routineId"],
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "routines.read",
      source: "core",
      async run(params, ctx) {
        const routineId = typeof params.routineId === "string" ? params.routineId.trim() : "";
        if (!routineId) return { ok: false, error: "routineId is required" };
        const routine = await routines.get(routineId);
        if (!routine || routine.companyId !== ctx.companyId) return { ok: false, error: "Routine not found" };
        const limit = clampListLimit(params.limit, 25);
        const runs = await routines.listRuns(routine.id, limit);
        return ok({
          routineId: routine.id,
          total: runs.length,
          runs,
        });
      },
    },
    {
      name: "list_issues",
      description:
        "List issues in this company. Returns up to 50 issues with status, priority, assignee, and identifier.",
      parametersSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Optional issue status filter.",
          },
        },
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "issues.read",
      source: "core",
      async run(params, ctx) {
        const status = typeof params.status === "string" ? params.status : undefined;
        const result = await issues.list(ctx.companyId, {
          ...(status ? { status } : {}),
          limit: LIST_RESULT_LIMIT,
        });
        const items = Array.isArray(result)
          ? result
          : Array.isArray((result as { items?: unknown[] }).items)
            ? (result as { items: unknown[] }).items
            : [];
        return ok({
          total: items.length,
          issues: items.map((row) => summarizeIssue(row as Record<string, unknown>)),
        });
      },
    },
    {
      name: "get_issue",
      description: "Get a single issue by UUID or identifier.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
        },
        required: ["issueId"],
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "issues.read",
      source: "core",
      async run(params, ctx) {
        const issueId = typeof params.issueId === "string" ? params.issueId.trim() : "";
        if (!issueId) return { ok: false, error: "issueId is required" };
        const row = await issues.getById(issueId);
        if (!row || row.companyId !== ctx.companyId) return { ok: false, error: "Issue not found" };
        return ok(row);
      },
    },
    {
      name: "list_issue_comments",
      description: "List durable comments for an issue.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          order: { type: "string", enum: ["asc", "desc"] },
          limit: { type: "number" },
        },
        required: ["issueId"],
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "issue.comments.read",
      source: "core",
      async run(params, ctx) {
        const issueId = typeof params.issueId === "string" ? params.issueId.trim() : "";
        if (!issueId) return { ok: false, error: "issueId is required" };
        const issue = await issues.getById(issueId);
        if (!issue || issue.companyId !== ctx.companyId) return { ok: false, error: "Issue not found" };
        const comments = await issues.listComments(issue.id, {
          order: params.order === "asc" ? "asc" : "desc",
          limit: clampListLimit(params.limit, 25),
        });
        return ok({
          issueId: issue.id,
          total: comments.length,
          comments,
        });
      },
    },
    {
      name: "list_approvals",
      description: "List approvals in this company, optionally filtered by status.",
      parametersSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
        },
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "approvals.read",
      source: "core",
      async run(params, ctx) {
        const status = typeof params.status === "string" ? params.status.trim() : undefined;
        const rows = await approvals.list(ctx.companyId, status || undefined);
        return ok({
          total: rows.length,
          approvals: rows.slice(0, LIST_RESULT_LIMIT).map((row) => summarizeApproval(row as unknown as Record<string, unknown>)),
        });
      },
    },
    {
      name: "get_approval",
      description: "Get a single approval by id.",
      parametersSchema: {
        type: "object",
        properties: {
          approvalId: { type: "string" },
        },
        required: ["approvalId"],
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "approvals.read",
      source: "core",
      async run(params, ctx) {
        const approvalId = typeof params.approvalId === "string" ? params.approvalId.trim() : "";
        if (!approvalId) return { ok: false, error: "approvalId is required" };
        const row = await approvals.getById(approvalId);
        if (!row || row.companyId !== ctx.companyId) return { ok: false, error: "Approval not found" };
        return ok(summarizeApproval(row as unknown as Record<string, unknown>));
      },
    },
    {
      name: "list_approval_comments",
      description: "List comments for an approval.",
      parametersSchema: {
        type: "object",
        properties: {
          approvalId: { type: "string" },
        },
        required: ["approvalId"],
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "approval.comments.read",
      source: "core",
      async run(params, ctx) {
        const approvalId = typeof params.approvalId === "string" ? params.approvalId.trim() : "";
        if (!approvalId) return { ok: false, error: "approvalId is required" };
        const approval = await approvals.getById(approvalId);
        if (!approval || approval.companyId !== ctx.companyId) return { ok: false, error: "Approval not found" };
        const comments = await approvals.listComments(approval.id);
        return ok({
          approvalId: approval.id,
          total: comments.length,
          comments,
        });
      },
    },
    {
      name: "list_invites",
      description: "List invite links/tokens for this company.",
      parametersSchema: {
        type: "object",
        properties: {
          state: { type: "string", enum: ["active", "accepted", "expired", "revoked"] },
          limit: { type: "number" },
          offset: { type: "number" },
        },
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "invites.read",
      source: "core",
      async run(params, ctx) {
        return ok(
          await invites.list(ctx.companyId, {
            state:
              params.state === "active" ||
              params.state === "accepted" ||
              params.state === "expired" ||
              params.state === "revoked"
                ? params.state
                : undefined,
            limit: clampListLimit(params.limit, 20),
            offset:
              typeof params.offset === "number" && Number.isFinite(params.offset)
                ? Math.max(0, Math.floor(params.offset))
                : 0,
          }),
        );
      },
    },
    {
      name: "list_activity",
      description: "List recent company activity rows with optional entity/agent filters.",
      parametersSchema: {
        type: "object",
        properties: {
          entityType: { type: "string" },
          entityId: { type: "string" },
          agentId: { type: "string" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "activity.read",
      source: "core",
      async run(params, ctx) {
        const events = await activity.list({
          companyId: ctx.companyId,
          entityType: typeof params.entityType === "string" ? params.entityType.trim() || undefined : undefined,
          entityId: typeof params.entityId === "string" ? params.entityId.trim() || undefined : undefined,
          agentId: typeof params.agentId === "string" ? params.agentId.trim() || undefined : undefined,
          limit: clampListLimit(params.limit, 25),
        });
        return ok({
          total: events.length,
          events,
        });
      },
    },
    {
      name: "list_agent_keys",
      description: "List API-key metadata for an agent. Never returns plaintext secrets.",
      parametersSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
        },
        required: ["agentId"],
        additionalProperties: false,
      },
      requiresApproval: false,
      capability: "agents.read",
      source: "core",
      async run(params, ctx) {
        const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
        if (!agentId) return { ok: false, error: "agentId is required" };
        const agent = await resolveAgentForCompany(db, ctx.companyId, agentId);
        if (!agent || agent.companyId !== ctx.companyId) return { ok: false, error: "Agent not found" };
        const keys = await agents.listKeys(agent.id);
        return ok({
          agentId: agent.id,
          total: keys.length,
          keys,
        });
      },
    },
    {
      name: "get_budget_summary",
      description:
        "Get the current monthly budget posture for this company: configured limit, current spend, and policy summary.",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      capability: "costs.read",
      source: "core",
      async run(_params, ctx) {
        let overview: unknown = null;
        try {
          overview = await budgets.overview(ctx.companyId);
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : "Failed to load budget overview",
          };
        }
        const company = await companies.getById(ctx.companyId);
        return ok({
          budgetMonthlyCents: company?.budgetMonthlyCents ?? null,
          spentMonthlyCents: company?.spentMonthlyCents ?? null,
          policy: overview,
        });
      },
    },
  ];
}

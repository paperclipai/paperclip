import type { Db } from "@paperclipai/db";
import {
  agentService,
  budgetService,
  companyService,
  goalService,
  issueService,
  routineService,
} from "../../index.js";
import type { BuilderTool, BuilderToolRunContext, BuilderToolRunResult } from "../types.js";

/**
 * Phase 0 read-only Builder tools.
 *
 * Each tool calls a core service function; never the database directly. This
 * keeps invariants (atomic checkout, approval gates, budget hard-stop, audit
 * logging) intact, per the "Tools call services, not HTTP" rule from
 * `doc/plans/2026-05-04-company-ai-builder.md` §3.
 *
 * v0 truncates list results to a small, predictable cap so a chatty model
 * does not blow the prompt window or accidentally exfiltrate large datasets.
 */

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
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeAgentId: row.assigneeAgentId ?? null,
    projectId: row.projectId ?? null,
  };
}

export function buildCoreReadOnlyTools(db: Db): BuilderTool[] {
  const companies = companyService(db);
  const agents = agentService(db);
  const goals = goalService(db);
  const routines = routineService(db);
  const issues = issueService(db);
  const budgets = budgetService(db);

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
        "List agents (employees) in this company. Returns up to 50 agents with their role, status, adapter type, and reporting line.",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      capability: "agents.read",
      source: "core",
      async run(_params, ctx) {
        const rows = await agents.list(ctx.companyId);
        return ok({
          total: rows.length,
          agents: rows
            .slice(0, LIST_RESULT_LIMIT)
            .map((row) => summarizeAgent(row as unknown as Record<string, unknown>)),
        });
      },
    },
    {
      name: "list_goals",
      description:
        "List goals in this company. Returns up to 50 goals with their level (company/team/individual), status, and parent.",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      capability: "goals.read",
      source: "core",
      async run(_params, ctx) {
        const rows = await goals.list(ctx.companyId);
        return ok({
          total: rows.length,
          goals: rows
            .slice(0, LIST_RESULT_LIMIT)
            .map((row) => summarizeGoal(row as unknown as Record<string, unknown>)),
        });
      },
    },
    {
      name: "list_routines",
      description:
        "List routines (recurring scheduled tasks) in this company. Returns up to 50 routines with status, priority, and assignee.",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      capability: "routines.read",
      source: "core",
      async run(_params, ctx) {
        const rows = await routines.list(ctx.companyId);
        return ok({
          total: rows.length,
          routines: rows
            .slice(0, LIST_RESULT_LIMIT)
            .map((row) => summarizeRoutine(row as unknown as Record<string, unknown>)),
        });
      },
    },
    {
      name: "list_issues",
      description:
        "List issues (tasks) in this company. Returns up to 50 most recent issues with status, priority, and assignee.",
      parametersSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Optional issue status filter (e.g. 'open', 'in_progress').",
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

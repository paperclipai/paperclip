import {
  agentService,
  budgetService,
  companyService,
  goalService,
  issueService,
  routineService,
} from "../../index.js";
import { logActivity } from "../../activity-log.js";
import type { BuilderTool } from "../types.js";
import { defineMutationTool } from "./mutation-tool.js";

/**
 * Phase 1 + Phase 2 mutation tools.
 *
 * All of these create a `builder_proposal` rather than mutating directly.
 * The actual write happens in the applier when the operator clicks Apply
 * (or, for governed primitives in Phase 2, when the linked approval is
 * decided through the normal Approvals UI).
 *
 * Schemas are intentionally permissive — service-layer validation is the
 * real gate, and the model gets a clear `error` back if it sends garbage.
 */

const stringOrNull = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const nonEmptyString = (v: unknown, field: string): string => {
  const s = stringOrNull(v);
  if (!s) throw new Error(`Missing required field: ${field}`);
  return s;
};

// ---------------------------------------------------------------------------
// Phase 1 — direct-apply mutations (proposal, but no separate approval row)
// ---------------------------------------------------------------------------

const createRoutine: BuilderTool = defineMutationTool({
  name: "create_routine",
  description:
    "Propose a new routine (recurring task). Creates a pending proposal — the operator must Apply it before the routine is created.",
  parametersSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Routine title (1-200 chars)." },
      description: { type: "string" },
      assigneeAgentId: { type: "string", description: "UUID of the assignee agent." },
      projectId: { type: "string" },
      goalId: { type: "string" },
      priority: {
        type: "string",
        enum: ["critical", "high", "medium", "low"],
      },
      status: {
        type: "string",
        enum: ["active", "paused", "archived"],
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
  capability: "routines.write",

  buildPayload(params) {
    return {
      title: nonEmptyString(params.title, "title"),
      description: stringOrNull(params.description),
      assigneeAgentId: stringOrNull(params.assigneeAgentId),
      projectId: stringOrNull(params.projectId),
      goalId: stringOrNull(params.goalId),
      priority: stringOrNull(params.priority) ?? "medium",
      status: stringOrNull(params.status) ?? "active",
    };
  },
  summarize(payload) {
    return `Create routine "${String(payload.title)}" (${String(payload.status)}, ${String(
      payload.priority,
    )})`;
  },
  async apply(payload, ctx) {
    const created = await routineService(ctx.db).create(
      ctx.companyId,
      {
        title: String(payload.title),
        description: (payload.description as string | null) ?? null,
        assigneeAgentId: (payload.assigneeAgentId as string | null) ?? null,
        projectId: (payload.projectId as string | null) ?? null,
        goalId: (payload.goalId as string | null) ?? null,
        priority: payload.priority as "critical" | "high" | "medium" | "low",
        status: payload.status as "active" | "paused" | "archived",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      { userId: ctx.decidedByUserId, agentId: null },
    );
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: "user",
      actorId: ctx.decidedByUserId,
      action: "routine.created",
      entityType: "routine",
      entityId: created.id,
      details: {
        source: "builder",
        title: created.title,
        viaProposalKind: "create_routine",
      },
    });
    return {
      summary: `Routine "${created.title}" created`,
      entityId: created.id,
      entityType: "routine",
      details: { id: created.id, title: created.title },
    };
  },
});

const updateRoutine: BuilderTool = defineMutationTool({
  name: "update_routine",
  description:
    "Propose changes to an existing routine (title, description, assignee, status, priority).",
  parametersSchema: {
    type: "object",
    properties: {
      routineId: { type: "string", description: "UUID of the routine to update." },
      title: { type: "string" },
      description: { type: "string" },
      assigneeAgentId: { type: "string" },
      status: { type: "string", enum: ["active", "paused", "archived"] },
      priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
    },
    required: ["routineId"],
    additionalProperties: false,
  },
  capability: "routines.write",

  buildPayload(params) {
    const patch: Record<string, unknown> = {};
    for (const key of ["title", "description", "assigneeAgentId", "status", "priority"] as const) {
      if (typeof params[key] === "string") patch[key] = (params[key] as string).trim();
    }
    return {
      routineId: nonEmptyString(params.routineId, "routineId"),
      patch,
    };
  },
  summarize(payload) {
    const patch = payload.patch as Record<string, unknown>;
    const fields = Object.keys(patch).join(", ") || "no fields";
    return `Update routine ${String(payload.routineId)} (${fields})`;
  },
  async apply(payload, ctx) {
    const updated = await routineService(ctx.db).update(
      String(payload.routineId),
      payload.patch as Record<string, unknown>,
      { userId: ctx.decidedByUserId, agentId: null },
    );
    if (!updated) throw new Error("Routine not found");
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: "user",
      actorId: ctx.decidedByUserId,
      action: "routine.updated",
      entityType: "routine",
      entityId: updated.id,
      details: { source: "builder", patch: payload.patch },
    });
    return {
      summary: `Routine ${updated.id} updated`,
      entityId: updated.id,
      entityType: "routine",
    };
  },
});

const createGoal: BuilderTool = defineMutationTool({
  name: "create_goal",
  description:
    "Propose a new goal. Goals organise work into measurable outcomes (`level`: company, team, individual).",
  parametersSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      level: { type: "string", enum: ["company", "team", "individual"] },
      parentId: { type: "string", description: "Optional parent goal UUID." },
    },
    required: ["title", "level"],
    additionalProperties: false,
  },
  capability: "goals.write",

  buildPayload(params) {
    return {
      title: nonEmptyString(params.title, "title"),
      description: stringOrNull(params.description),
      level: nonEmptyString(params.level, "level"),
      parentId: stringOrNull(params.parentId),
    };
  },
  summarize(payload) {
    return `Create ${String(payload.level)} goal "${String(payload.title)}"`;
  },
  async apply(payload, ctx) {
    const created = await goalService(ctx.db).create(ctx.companyId, {
      title: String(payload.title),
      description: (payload.description as string | null) ?? null,
      level: payload.level as "company" | "team" | "individual",
      status: "active",
      parentId: (payload.parentId as string | null) ?? null,
    });
    if (!created) throw new Error("Goal creation returned no row");
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: "user",
      actorId: ctx.decidedByUserId,
      action: "goal.created",
      entityType: "goal",
      entityId: created.id,
      details: { source: "builder", title: created.title },
    });
    return { summary: `Goal "${created.title}" created`, entityId: created.id, entityType: "goal" };
  },
});

const updateGoal: BuilderTool = defineMutationTool({
  name: "update_goal",
  description: "Propose changes to an existing goal.",
  parametersSchema: {
    type: "object",
    properties: {
      goalId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      status: { type: "string", enum: ["active", "completed", "archived"] },
    },
    required: ["goalId"],
    additionalProperties: false,
  },
  capability: "goals.write",

  buildPayload(params) {
    const patch: Record<string, unknown> = {};
    for (const key of ["title", "description", "status"] as const) {
      if (typeof params[key] === "string") patch[key] = (params[key] as string).trim();
    }
    return {
      goalId: nonEmptyString(params.goalId, "goalId"),
      patch,
    };
  },
  summarize(payload) {
    const fields = Object.keys(payload.patch as Record<string, unknown>).join(", ") || "no fields";
    return `Update goal ${String(payload.goalId)} (${fields})`;
  },
  async apply(payload, ctx) {
    const updated = await goalService(ctx.db).update(
      String(payload.goalId),
      payload.patch as Record<string, unknown>,
    );
    if (!updated) throw new Error("Goal not found");
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: "user",
      actorId: ctx.decidedByUserId,
      action: "goal.updated",
      entityType: "goal",
      entityId: updated.id,
      details: { source: "builder", patch: payload.patch },
    });
    return { summary: `Goal ${updated.id} updated`, entityId: updated.id, entityType: "goal" };
  },
});

const createIssue: BuilderTool = defineMutationTool({
  name: "create_issue",
  description: "Propose a new issue (task).",
  parametersSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      projectId: { type: "string" },
      assigneeAgentId: { type: "string" },
      priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
      status: {
        type: "string",
        enum: ["open", "in_progress", "blocked", "done", "cancelled"],
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
  capability: "issues.write",

  buildPayload(params) {
    return {
      title: nonEmptyString(params.title, "title"),
      description: stringOrNull(params.description),
      projectId: stringOrNull(params.projectId),
      assigneeAgentId: stringOrNull(params.assigneeAgentId),
      priority: stringOrNull(params.priority) ?? "medium",
      status: stringOrNull(params.status) ?? "open",
    };
  },
  summarize(payload) {
    return `Create issue "${String(payload.title)}" (${String(payload.status)})`;
  },
  async apply(payload, ctx) {
    const created = await issueService(ctx.db).create(ctx.companyId, {
      title: String(payload.title),
      description: (payload.description as string | null) ?? null,
      projectId: (payload.projectId as string | null) ?? null,
      assigneeAgentId: (payload.assigneeAgentId as string | null) ?? null,
      priority: payload.priority as string,
      status: payload.status as string,
      createdByUserId: ctx.decidedByUserId,
      createdByAgentId: null,
    } as Parameters<ReturnType<typeof issueService>["create"]>[1]);
    if (!created) throw new Error("Issue creation returned no row");
    const issueRow = created as { id: string; title: string };
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: "user",
      actorId: ctx.decidedByUserId,
      action: "issue.created",
      entityType: "issue",
      entityId: issueRow.id,
      details: { source: "builder", title: issueRow.title },
    });
    return {
      summary: `Issue "${issueRow.title}" created`,
      entityId: issueRow.id,
      entityType: "issue",
    };
  },
});

const updateIssue: BuilderTool = defineMutationTool({
  name: "update_issue",
  description: "Propose changes to an existing issue.",
  parametersSchema: {
    type: "object",
    properties: {
      issueId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      assigneeAgentId: { type: "string" },
      status: {
        type: "string",
        enum: ["open", "in_progress", "blocked", "done", "cancelled"],
      },
      priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
    },
    required: ["issueId"],
    additionalProperties: false,
  },
  capability: "issues.write",

  buildPayload(params) {
    const patch: Record<string, unknown> = {};
    for (const key of ["title", "description", "assigneeAgentId", "status", "priority"] as const) {
      if (typeof params[key] === "string") patch[key] = (params[key] as string).trim();
    }
    return {
      issueId: nonEmptyString(params.issueId, "issueId"),
      patch,
    };
  },
  summarize(payload) {
    const fields = Object.keys(payload.patch as Record<string, unknown>).join(", ") || "no fields";
    return `Update issue ${String(payload.issueId)} (${fields})`;
  },
  async apply(payload, ctx) {
    const result = (await issueService(ctx.db).update(
      String(payload.issueId),
      payload.patch as Parameters<ReturnType<typeof issueService>["update"]>[1],
      { actorType: "user", userId: ctx.decidedByUserId, agentId: null } as never,
    )) as { id: string } | null;
    if (!result) throw new Error("Issue not found");
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: "user",
      actorId: ctx.decidedByUserId,
      action: "issue.updated",
      entityType: "issue",
      entityId: result.id,
      details: { source: "builder", patch: payload.patch },
    });
    return { summary: `Issue ${result.id} updated`, entityId: result.id, entityType: "issue" };
  },
});

// ---------------------------------------------------------------------------
// Phase 2 — governed primitives that route through `approvalService`
// ---------------------------------------------------------------------------

const hireAgent: BuilderTool = defineMutationTool({
  name: "hire_agent",
  description:
    "Propose hiring (creating) a new agent. Generates a `hire_agent` approval that the board approves through the standard Approvals UI; the agent is created when the approval is approved.",
  parametersSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      role: { type: "string" },
      title: { type: "string" },
      reportsTo: { type: "string", description: "UUID of the manager agent." },
      adapterType: { type: "string", description: "e.g. process, claude_local, codex_local" },
      budgetMonthlyCents: { type: "number" },
      capabilities: { type: "string" },
    },
    required: ["name", "role", "adapterType"],
    additionalProperties: false,
  },
  capability: "agents.write",

  approvalType: "hire_agent",
  buildPayload(params) {
    return {
      name: nonEmptyString(params.name, "name"),
      role: nonEmptyString(params.role, "role"),
      title: stringOrNull(params.title),
      reportsTo: stringOrNull(params.reportsTo),
      adapterType: nonEmptyString(params.adapterType, "adapterType"),
      capabilities: stringOrNull(params.capabilities),
      adapterConfig: {},
      budgetMonthlyCents:
        typeof params.budgetMonthlyCents === "number" && Number.isFinite(params.budgetMonthlyCents)
          ? Math.max(0, Math.floor(params.budgetMonthlyCents))
          : 0,
    };
  },
  summarize(payload) {
    return `Hire agent "${String(payload.name)}" as ${String(payload.role)} (adapter ${String(
      payload.adapterType,
    )})`;
  },
  async apply(_payload, _ctx) {
    // The approvalService handles the actual hire when the board approves
    // the linked approval row. The Builder UI just marks the proposal applied
    // once the operator clicks "Apply" here, which means "yes, please send
    // this through the standard Approvals queue".
    return {
      summary: "Hire request sent to Approvals queue",
      entityType: "approval",
    };
  },
});

const setBudget: BuilderTool = defineMutationTool({
  name: "set_budget",
  description:
    "Propose updating a budget policy (company-wide or per-agent monthly cap). Goes through the standard Approvals UI.",
  parametersSchema: {
    type: "object",
    properties: {
      scopeType: { type: "string", enum: ["company", "agent", "project"] },
      scopeId: { type: "string", description: "UUID — for `company` use the current company id." },
      amountCents: { type: "number", description: "Monthly cap in cents." },
      hardStopEnabled: { type: "boolean" },
    },
    required: ["scopeType", "scopeId", "amountCents"],
    additionalProperties: false,
  },
  capability: "budgets.write",

  approvalType: "set_budget",
  buildPayload(params, ctx) {
    const scopeType = nonEmptyString(params.scopeType, "scopeType");
    if (!["company", "agent", "project"].includes(scopeType)) {
      throw new Error("scopeType must be company, agent, or project");
    }
    const scopeId =
      scopeType === "company" ? ctx.companyId : nonEmptyString(params.scopeId, "scopeId");
    const amount = Number(params.amountCents);
    if (!Number.isFinite(amount) || amount < 0) throw new Error("amountCents must be a non-negative number");
    return {
      scopeType,
      scopeId,
      amountCents: Math.floor(amount),
      hardStopEnabled: typeof params.hardStopEnabled === "boolean" ? params.hardStopEnabled : true,
    };
  },
  summarize(payload) {
    return `Set ${String(payload.scopeType)} budget (${String(payload.scopeId)}) → ${String(
      payload.amountCents,
    )}¢`;
  },
  async apply(payload, ctx) {
    const updated = await budgetService(ctx.db).upsertPolicy(
      ctx.companyId,
      {
        scopeType: payload.scopeType as "company" | "agent" | "project",
        scopeId: String(payload.scopeId),
        amount: Number(payload.amountCents),
        hardStopEnabled: Boolean(payload.hardStopEnabled),
      },
      ctx.decidedByUserId,
    );
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: "user",
      actorId: ctx.decidedByUserId,
      action: "budget.policy_updated",
      entityType: "budget_policy",
      entityId: (updated as { id?: string }).id ?? String(payload.scopeId),
      details: { source: "builder", scope: payload.scopeType, scopeId: payload.scopeId },
    });
    return {
      summary: `${String(payload.scopeType)} budget updated`,
      entityId: (updated as { id?: string }).id ?? null,
      entityType: "budget_policy",
    };
  },
});

const updateCompany: BuilderTool = defineMutationTool({
  name: "update_company",
  description: "Propose updating company metadata (name, description, monthly budget cap).",
  parametersSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      budgetMonthlyCents: { type: "number" },
    },
    additionalProperties: false,
  },
  capability: "companies.write",

  approvalType: "update_company",
  buildPayload(params) {
    const patch: Record<string, unknown> = {};
    if (typeof params.name === "string" && params.name.trim()) patch.name = params.name.trim();
    if (typeof params.description === "string") patch.description = params.description;
    if (
      typeof params.budgetMonthlyCents === "number" &&
      Number.isFinite(params.budgetMonthlyCents) &&
      params.budgetMonthlyCents >= 0
    ) {
      patch.budgetMonthlyCents = Math.floor(params.budgetMonthlyCents);
    }
    if (Object.keys(patch).length === 0) {
      throw new Error("At least one of name, description, or budgetMonthlyCents must be provided");
    }
    return { patch };
  },
  summarize(payload) {
    const fields = Object.keys(payload.patch as Record<string, unknown>).join(", ");
    return `Update company (${fields})`;
  },
  async apply(payload, ctx) {
    const updated = await companyService(ctx.db).update(
      ctx.companyId,
      payload.patch as Record<string, unknown>,
    );
    if (!updated) throw new Error("Company not found");
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: "user",
      actorId: ctx.decidedByUserId,
      action: "company.updated",
      entityType: "company",
      entityId: ctx.companyId,
      details: { source: "builder", patch: payload.patch },
    });
    return { summary: "Company metadata updated", entityId: ctx.companyId, entityType: "company" };
  },
});

const grantAccess: BuilderTool = defineMutationTool({
  name: "grant_access",
  description:
    "Propose granting a user access to this company. Goes through the Approvals UI before any access is granted.",
  parametersSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      role: { type: "string", enum: ["owner", "admin", "member", "viewer"] },
      reason: { type: "string" },
    },
    required: ["userId", "role"],
    additionalProperties: false,
  },
  capability: "access.write",

  approvalType: "grant_access",
  buildPayload(params) {
    return {
      userId: nonEmptyString(params.userId, "userId"),
      role: nonEmptyString(params.role, "role"),
      reason: stringOrNull(params.reason),
    };
  },
  summarize(payload) {
    return `Grant ${String(payload.role)} access to user ${String(payload.userId)}`;
  },
  async apply(_payload, _ctx) {
    // The grant is performed by the access service when the linked approval
    // is approved; here we only log an audit entry confirming the operator
    // sent the proposal forward.
    return {
      summary: "Access grant request sent to Approvals queue",
      entityType: "approval",
    };
  },
});

export function buildCoreMutationTools(): BuilderTool[] {
  return [
    createRoutine,
    updateRoutine,
    createGoal,
    updateGoal,
    createIssue,
    updateIssue,
    hireAgent,
    setBudget,
    updateCompany,
    grantAccess,
  ];
}

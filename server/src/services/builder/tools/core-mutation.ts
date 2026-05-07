import {
  addApprovalCommentSchema,
  createCompanyInviteSchema,
  createProjectSchema,
  createRoutineTriggerSchema,
  runRoutineSchema,
  updateAgentSchema,
  updateProjectSchema,
  updateRoutineTriggerSchema,
} from "@paperclipai/shared";
import {
  agentService,
  approvalService,
  goalService,
  inviteService,
  issueService,
  projectService,
  routineService,
} from "../../index.js";
import { logActivity } from "../../activity-log.js";
import { logger } from "../../../middleware/logger.js";
import { builderProposalStore } from "../proposal-store.js";
import type { BuilderTool } from "../types.js";
import { defineMutationTool } from "./mutation-tool.js";

const stringOrNull = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const nonEmptyString = (value: unknown, field: string): string => {
  const parsed = stringOrNull(value);
  if (!parsed) throw new Error(`Missing required field: ${field}`);
  return parsed;
};

function finiteNonNegativeInteger(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return Math.floor(value);
}

async function logBuilderAction(
  ctx: { db: any; companyId: string; decidedByUserId: string | null },
  input: {
    action: string;
    entityType: string;
    entityId: string;
    details?: Record<string, unknown> | null;
  },
) {
  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: "user",
    actorId: ctx.decidedByUserId ?? "board",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    details: input.details ?? null,
  }).catch((logErr) =>
    logger.warn({ logErr, entityId: input.entityId, action: input.action }, "builder activity log failed"),
  );
}

async function assertApprovalIsNotLinkedBuilderGovernedFlow(
  ctx: { db: any; companyId: string },
  approvalId: string,
) {
  const linkedProposal = await builderProposalStore(ctx.db).getByApprovalId(ctx.companyId, approvalId);
  if (linkedProposal) {
    throw new Error("This approval must be resolved from the Approvals queue");
  }
}

async function assertGoalIdsBelongToCompany(
  db: any,
  companyId: string,
  goalIds: string[] | undefined,
) {
  for (const goalId of goalIds ?? []) {
    await assertGoalBelongsToCompany(db, companyId, goalId);
  }
}

async function assertGoalBelongsToCompany(db: any, companyId: string, goalId: string | null) {
  if (!goalId) return;
  const goal = await goalService(db).getById(goalId);
  if (!goal || goal.companyId !== companyId) {
    throw new Error("Goal not found");
  }
}

async function assertProjectBelongsToCompany(db: any, companyId: string, projectId: string | null) {
  if (!projectId) return;
  const project = await projectService(db).getById(projectId);
  if (!project || project.companyId !== companyId) {
    throw new Error("Project not found");
  }
}

async function assertAgentBelongsToCompany(db: any, companyId: string, agentId: string | null, label = "Agent") {
  if (!agentId) return;
  const agent = await agentService(db).getById(agentId);
  if (!agent || agent.companyId !== companyId) {
    throw new Error(`${label} not found`);
  }
}

const addIssueComment: BuilderTool = {
  name: "add_issue_comment",
  description: "Add a durable comment to an issue immediately.",
  parametersSchema: {
    type: "object",
    properties: {
      issueId: { type: "string" },
      body: { type: "string" },
    },
    required: ["issueId", "body"],
    additionalProperties: false,
  },
  requiresApproval: false,
  capability: "issue.comments.create",
  source: "core",
  async run(params, ctx) {
    const issueId = nonEmptyString(params.issueId, "issueId");
    const body = nonEmptyString(params.body, "body");
    const issue = await issueService(ctx.db).getById(issueId);
    if (!issue || issue.companyId !== ctx.companyId) {
      return { ok: false, error: "Issue not found" };
    }
    const comment = await issueService(ctx.db).addComment(issue.id, body, {
      userId: ctx.actor.type === "user" ? ctx.actor.id ?? undefined : undefined,
    });
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: "user",
      actorId: ctx.actor.id ?? "board",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issue.id,
      details: { commentId: comment.id },
    }).catch((logErr) =>
      logger.warn({ logErr, issueId: issue.id }, "add_issue_comment: activity log failed"),
    );
    return {
      ok: true,
      result: comment,
    };
  },
};

const addApprovalComment: BuilderTool = {
  name: "add_approval_comment",
  description: "Add a durable comment to an approval immediately.",
  parametersSchema: {
    type: "object",
    properties: {
      approvalId: { type: "string" },
      body: { type: "string" },
    },
    required: ["approvalId", "body"],
    additionalProperties: false,
  },
  requiresApproval: false,
  capability: "approval.comments.create",
  source: "core",
  async run(params, ctx) {
    const approvalId = nonEmptyString(params.approvalId, "approvalId");
    const parsed = addApprovalCommentSchema.parse({ body: params.body });
    const approval = await approvalService(ctx.db).getById(approvalId);
    if (!approval || approval.companyId !== ctx.companyId) {
      return { ok: false, error: "Approval not found" };
    }
    const comment = await approvalService(ctx.db).addComment(approval.id, parsed.body, {
      userId: ctx.actor.type === "user" ? ctx.actor.id ?? undefined : undefined,
    });
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: "user",
      actorId: ctx.actor.id ?? "board",
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    }).catch((logErr) =>
      logger.warn({ logErr, approvalId: approval.id }, "add_approval_comment: activity log failed"),
    );
    return {
      ok: true,
      result: comment,
    };
  },
};

const runRoutine: BuilderTool = {
  name: "run_routine",
  description: "Trigger a routine immediately.",
  parametersSchema: {
    type: "object",
    properties: {
      routineId: { type: "string" },
      triggerId: { type: "string" },
      payload: { type: "object" },
      variables: { type: "object" },
      projectId: { type: "string" },
      assigneeAgentId: { type: "string" },
      idempotencyKey: { type: "string" },
      source: { type: "string", enum: ["manual", "api"] },
      executionWorkspaceId: { type: "string" },
      executionWorkspacePreference: { type: "string" },
      executionWorkspaceSettings: { type: "object" },
    },
    required: ["routineId"],
    additionalProperties: false,
  },
  requiresApproval: false,
  capability: "routines.write",
  source: "core",
  async run(params, ctx) {
    const routineId = nonEmptyString(params.routineId, "routineId");
    const routine = await routineService(ctx.db).get(routineId);
    if (!routine || routine.companyId !== ctx.companyId) {
      return { ok: false, error: "Routine not found" };
    }
    const parsed = runRoutineSchema.parse({
      triggerId: params.triggerId,
      payload: params.payload,
      variables: params.variables,
      projectId: params.projectId,
      assigneeAgentId: params.assigneeAgentId,
      idempotencyKey: params.idempotencyKey,
      source: params.source,
      executionWorkspaceId: params.executionWorkspaceId,
      executionWorkspacePreference: params.executionWorkspacePreference,
      executionWorkspaceSettings: params.executionWorkspaceSettings,
    });
    if (parsed.triggerId) {
      const trigger = await routineService(ctx.db).getTrigger(parsed.triggerId);
      if (!trigger || trigger.companyId !== ctx.companyId) {
        return { ok: false, error: "Routine trigger not found" };
      }
    }
    await assertProjectBelongsToCompany(ctx.db, ctx.companyId, parsed.projectId ?? null);
    await assertAgentBelongsToCompany(
      ctx.db,
      ctx.companyId,
      parsed.assigneeAgentId ?? null,
      "Assignee agent",
    );
    const run = await routineService(ctx.db).runRoutine(routine.id, parsed);
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: "user",
      actorId: ctx.actor.id ?? "board",
      action: "routine.run_triggered",
      entityType: "routine_run",
      entityId: run.id,
      details: { routineId: routine.id, source: run.source, status: run.status },
    }).catch((logErr) =>
      logger.warn({ logErr, routineId: routine.id }, "run_routine: activity log failed"),
    );
    return {
      ok: true,
      result: run,
    };
  },
};

const createRoutine = defineMutationTool({
  name: "create_routine",
  description:
    "Propose a new routine (recurring task). Creates a pending proposal that must be applied before the routine is created.",
  parametersSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      assigneeAgentId: { type: "string" },
      projectId: { type: "string" },
      goalId: { type: "string" },
      priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
      status: { type: "string", enum: ["active", "paused", "archived"] },
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
    return `Create routine "${String(payload.title)}" (${String(payload.status)}, ${String(payload.priority)})`;
  },
  async apply(payload, ctx) {
    if (payload.goalId) {
      const goal = await goalService(ctx.db).getById(String(payload.goalId));
      if (!goal || goal.companyId !== ctx.companyId) throw new Error("Goal not found");
    }
    await assertProjectBelongsToCompany(ctx.db, ctx.companyId, (payload.projectId as string | null) ?? null);
    await assertAgentBelongsToCompany(ctx.db, ctx.companyId, (payload.assigneeAgentId as string | null) ?? null, "Assignee agent");
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
    await logBuilderAction(ctx, {
      action: "routine.created",
      entityType: "routine",
      entityId: created.id,
      details: { source: "builder", title: created.title },
    });
    return {
      summary: `Routine "${created.title}" created`,
      entityId: created.id,
      entityType: "routine",
      details: { id: created.id, title: created.title },
    };
  },
});

const updateRoutine = defineMutationTool({
  name: "update_routine",
  description: "Propose changes to an existing routine.",
  parametersSchema: {
    type: "object",
    properties: {
      routineId: { type: "string" },
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
    const fields = Object.keys(payload.patch as Record<string, unknown>).join(", ") || "no fields";
    return `Update routine ${String(payload.routineId)} (${fields})`;
  },
  async apply(payload, ctx) {
    const existing = await routineService(ctx.db).get(String(payload.routineId));
    if (!existing || existing.companyId !== ctx.companyId) throw new Error("Routine not found");
    const patch = payload.patch as Record<string, unknown>;
    await assertAgentBelongsToCompany(ctx.db, ctx.companyId, (patch.assigneeAgentId as string | null) ?? null, "Assignee agent");
    const updated = await routineService(ctx.db).update(
      String(payload.routineId),
      patch,
      { userId: ctx.decidedByUserId, agentId: null },
    );
    if (!updated) throw new Error("Routine not found");
    await logBuilderAction(ctx, {
      action: "routine.updated",
      entityType: "routine",
      entityId: updated.id,
      details: { source: "builder", patch },
    });
    return {
      summary: `Routine ${updated.id} updated`,
      entityId: updated.id,
      entityType: "routine",
    };
  },
});

const createGoal = defineMutationTool({
  name: "create_goal",
  description: "Propose a new goal.",
  parametersSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      level: { type: "string", enum: ["company", "team", "individual"] },
      parentId: { type: "string" },
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
    if (payload.parentId) {
      const parent = await goalService(ctx.db).getById(String(payload.parentId));
      if (!parent || parent.companyId !== ctx.companyId) throw new Error("Parent goal not found");
    }
    const created = await goalService(ctx.db).create(ctx.companyId, {
      title: String(payload.title),
      description: (payload.description as string | null) ?? null,
      level: payload.level as "company" | "team" | "individual",
      status: "active",
      parentId: (payload.parentId as string | null) ?? null,
    });
    if (!created) throw new Error("Goal creation returned no row");
    await logBuilderAction(ctx, {
      action: "goal.created",
      entityType: "goal",
      entityId: created.id,
      details: { source: "builder", title: created.title },
    });
    return {
      summary: `Goal "${created.title}" created`,
      entityId: created.id,
      entityType: "goal",
    };
  },
});

const updateGoal = defineMutationTool({
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
    const existing = await goalService(ctx.db).getById(String(payload.goalId));
    if (!existing || existing.companyId !== ctx.companyId) throw new Error("Goal not found");
    const updated = await goalService(ctx.db).update(String(payload.goalId), payload.patch as Record<string, unknown>);
    if (!updated) throw new Error("Goal not found");
    await logBuilderAction(ctx, {
      action: "goal.updated",
      entityType: "goal",
      entityId: updated.id,
      details: { source: "builder", patch: payload.patch as Record<string, unknown> },
    });
    return {
      summary: `Goal ${updated.id} updated`,
      entityId: updated.id,
      entityType: "goal",
    };
  },
});

const createIssue = defineMutationTool({
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
      status: { type: "string", enum: ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] },
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
      status: stringOrNull(params.status) ?? "todo",
    };
  },
  summarize(payload) {
    return `Create issue "${String(payload.title)}" (${String(payload.status)})`;
  },
  async apply(payload, ctx) {
    await assertProjectBelongsToCompany(ctx.db, ctx.companyId, (payload.projectId as string | null) ?? null);
    await assertAgentBelongsToCompany(ctx.db, ctx.companyId, (payload.assigneeAgentId as string | null) ?? null, "Assignee agent");
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
    await logBuilderAction(ctx, {
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

const updateIssue = defineMutationTool({
  name: "update_issue",
  description: "Propose changes to an existing issue.",
  parametersSchema: {
    type: "object",
    properties: {
      issueId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      assigneeAgentId: { type: "string" },
      status: { type: "string", enum: ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] },
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
    const existing = await issueService(ctx.db).getById(String(payload.issueId));
    if (!existing || existing.companyId !== ctx.companyId) throw new Error("Issue not found");
    const patch = payload.patch as Record<string, unknown>;
    await assertAgentBelongsToCompany(ctx.db, ctx.companyId, (patch.assigneeAgentId as string | null) ?? null, "Assignee agent");
    const updated = await issueService(ctx.db).update(
      String(payload.issueId),
      patch as Parameters<ReturnType<typeof issueService>["update"]>[1],
      { actorType: "user", userId: ctx.decidedByUserId, agentId: null } as never,
    );
    if (!updated) throw new Error("Issue not found");
    await logBuilderAction(ctx, {
      action: "issue.updated",
      entityType: "issue",
      entityId: updated.id,
      details: { source: "builder", patch },
    });
    return {
      summary: `Issue ${updated.id} updated`,
      entityId: updated.id,
      entityType: "issue",
    };
  },
});

const createProject = defineMutationTool({
  name: "create_project",
  description: "Propose a new project.",
  parametersSchema: {
    type: "object",
    properties: {
      goalId: { type: "string" },
      goalIds: { type: "array", items: { type: "string" } },
      name: { type: "string" },
      description: { type: "string" },
      status: { type: "string" },
      leadAgentId: { type: "string" },
      targetDate: { type: "string" },
      color: { type: "string" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  capability: "projects.write",
  async buildPayload(params, ctx) {
    const parsed = createProjectSchema.parse({
      goalId: params.goalId,
      goalIds: params.goalIds,
      name: params.name,
      description: params.description,
      status: params.status,
      leadAgentId: params.leadAgentId,
      targetDate: params.targetDate,
      color: params.color,
    });
    if ((params as Record<string, unknown>).workspace !== undefined) {
      throw new Error("Project workspace creation is not supported through this tool");
    }
    await assertGoalBelongsToCompany(ctx.db, ctx.companyId, (parsed.goalId as string | null) ?? null);
    await assertGoalIdsBelongToCompany(ctx.db, ctx.companyId, parsed.goalIds as string[] | undefined);
    await assertAgentBelongsToCompany(ctx.db, ctx.companyId, (parsed.leadAgentId as string | null) ?? null, "Lead agent");
    return parsed as unknown as Record<string, unknown>;
  },
  summarize(payload) {
    return `Create project "${String(payload.name)}"`;
  },
  async apply(payload, ctx) {
    await assertGoalBelongsToCompany(ctx.db, ctx.companyId, (payload.goalId as string | null) ?? null);
    await assertGoalIdsBelongToCompany(ctx.db, ctx.companyId, payload.goalIds as string[] | undefined);
    await assertAgentBelongsToCompany(ctx.db, ctx.companyId, (payload.leadAgentId as string | null) ?? null, "Lead agent");
    const created = await projectService(ctx.db).create(ctx.companyId, payload as any);
    await logBuilderAction(ctx, {
      action: "project.created",
      entityType: "project",
      entityId: created.id,
      details: { source: "builder", name: created.name },
    });
    return {
      summary: `Project "${created.name}" created`,
      entityId: created.id,
      entityType: "project",
    };
  },
});

const updateProject = defineMutationTool({
  name: "update_project",
  description: "Propose changes to an existing project.",
  parametersSchema: {
    type: "object",
    properties: {
      projectId: { type: "string" },
      goalId: { type: "string" },
      goalIds: { type: "array", items: { type: "string" } },
      name: { type: "string" },
      description: { type: "string" },
      status: { type: "string" },
      leadAgentId: { type: "string" },
      targetDate: { type: "string" },
      color: { type: "string" },
      archivedAt: { type: "string" },
    },
    required: ["projectId"],
    additionalProperties: false,
  },
  capability: "projects.write",
  async buildPayload(params, ctx) {
    const projectId = nonEmptyString(params.projectId, "projectId");
    const parsed = updateProjectSchema.parse({
      goalId: params.goalId,
      goalIds: params.goalIds,
      name: params.name,
      description: params.description,
      status: params.status,
      leadAgentId: params.leadAgentId,
      targetDate: params.targetDate,
      color: params.color,
      archivedAt: params.archivedAt,
    });
    await assertGoalBelongsToCompany(ctx.db, ctx.companyId, (parsed.goalId as string | null) ?? null);
    await assertGoalIdsBelongToCompany(ctx.db, ctx.companyId, parsed.goalIds as string[] | undefined);
    await assertAgentBelongsToCompany(ctx.db, ctx.companyId, (parsed.leadAgentId as string | null) ?? null, "Lead agent");
    return {
      projectId,
      patch: parsed as Record<string, unknown>,
    };
  },
  summarize(payload) {
    const fields = Object.keys(payload.patch as Record<string, unknown>).join(", ") || "no fields";
    return `Update project ${String(payload.projectId)} (${fields})`;
  },
  async apply(payload, ctx) {
    const existing = await projectService(ctx.db).getById(String(payload.projectId));
    if (!existing || existing.companyId !== ctx.companyId) throw new Error("Project not found");
    const patch = payload.patch as Record<string, unknown>;
    await assertGoalBelongsToCompany(ctx.db, ctx.companyId, (patch.goalId as string | null) ?? null);
    await assertGoalIdsBelongToCompany(ctx.db, ctx.companyId, patch.goalIds as string[] | undefined);
    await assertAgentBelongsToCompany(ctx.db, ctx.companyId, (patch.leadAgentId as string | null) ?? null, "Lead agent");
    const updated = await projectService(ctx.db).update(existing.id, patch as any);
    if (!updated) throw new Error("Project not found");
    await logBuilderAction(ctx, {
      action: "project.updated",
      entityType: "project",
      entityId: updated.id,
      details: { source: "builder", patch },
    });
    return {
      summary: `Project ${updated.id} updated`,
      entityId: updated.id,
      entityType: "project",
    };
  },
});

const updateAgent = defineMutationTool({
  name: "update_agent",
  description: "Propose organizational changes to an existing agent.",
  parametersSchema: {
    type: "object",
    properties: {
      agentId: { type: "string" },
      name: { type: "string" },
      role: { type: "string" },
      title: { type: "string" },
      icon: { type: "string" },
      reportsTo: { type: "string" },
      capabilities: { type: "string" },
      metadata: { type: "object" },
    },
    required: ["agentId"],
    additionalProperties: false,
  },
  capability: "agents.write",
  buildPayload(params) {
    const agentId = nonEmptyString(params.agentId, "agentId");
    if (params.budgetMonthlyCents !== undefined) {
      throw new Error("Use set_budget instead of update_agent for budget changes");
    }
    const parsed = updateAgentSchema.parse({
      name: params.name,
      role: params.role,
      title: params.title,
      icon: params.icon,
      reportsTo: params.reportsTo,
      capabilities: params.capabilities,
      metadata: params.metadata,
    });
    if ((parsed as Record<string, unknown>).status !== undefined) {
      throw new Error("Use lifecycle tools instead of update_agent for status changes");
    }
    if ((parsed as Record<string, unknown>).adapterConfig !== undefined || (parsed as Record<string, unknown>).adapterType !== undefined) {
      throw new Error("Adapter configuration changes are not supported through this tool");
    }
    return {
      agentId,
      patch: parsed as Record<string, unknown>,
    };
  },
  summarize(payload) {
    const fields = Object.keys(payload.patch as Record<string, unknown>).join(", ") || "no fields";
    return `Update agent ${String(payload.agentId)} (${fields})`;
  },
  async apply(payload, ctx) {
    const existing = await agentService(ctx.db).getById(String(payload.agentId));
    if (!existing || existing.companyId !== ctx.companyId) throw new Error("Agent not found");
    const patch = payload.patch as Record<string, unknown>;
    await assertAgentBelongsToCompany(ctx.db, ctx.companyId, (patch.reportsTo as string | null) ?? null, "Manager agent");
    const updated = await agentService(ctx.db).update(existing.id, patch as any, {
      recordRevision: {
        createdByUserId: ctx.decidedByUserId,
        source: "builder",
      },
    });
    if (!updated) throw new Error("Agent not found");
    await logBuilderAction(ctx, {
      action: "agent.updated",
      entityType: "agent",
      entityId: updated.id,
      details: patch,
    });
    return {
      summary: `Agent ${updated.name} updated`,
      entityId: updated.id,
      entityType: "agent",
    };
  },
});

function makeAgentLifecycleTool(def: {
  name: "pause_agent" | "resume_agent" | "terminate_agent" | "delete_agent";
  description: string;
  summary: string;
  action: string;
  applyAgent: (db: any, agentId: string) => Promise<{ id: string; name?: string | null } | null>;
}) {
  return defineMutationTool({
    name: def.name,
    description: def.description,
    parametersSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
      },
      required: ["agentId"],
      additionalProperties: false,
    },
    capability: "agents.write",
    buildPayload(params) {
      return { agentId: nonEmptyString(params.agentId, "agentId") };
    },
    summarize(payload) {
      return `${def.summary} ${String(payload.agentId)}`;
    },
    async apply(payload, ctx) {
      const existing = await agentService(ctx.db).getById(String(payload.agentId));
      if (!existing || existing.companyId !== ctx.companyId) throw new Error("Agent not found");
      const updated = await def.applyAgent(ctx.db, existing.id);
      if (!updated) throw new Error("Agent not found");
      await logBuilderAction(ctx, {
        action: def.action,
        entityType: "agent",
        entityId: existing.id,
        details: null,
      });
      return {
        summary: `${def.summary} ${existing.name}`,
        entityId: existing.id,
        entityType: "agent",
      };
    },
  });
}

const pauseAgent = makeAgentLifecycleTool({
  name: "pause_agent",
  description: "Propose pausing an agent.",
  summary: "Pause agent",
  action: "agent.paused",
  applyAgent: (db, agentId) => agentService(db).pause(agentId),
});

const resumeAgent = makeAgentLifecycleTool({
  name: "resume_agent",
  description: "Propose resuming a paused agent.",
  summary: "Resume agent",
  action: "agent.resumed",
  applyAgent: (db, agentId) => agentService(db).resume(agentId),
});

const terminateAgent = makeAgentLifecycleTool({
  name: "terminate_agent",
  description: "Propose terminating an agent.",
  summary: "Terminate agent",
  action: "agent.terminated",
  applyAgent: (db, agentId) => agentService(db).terminate(agentId),
});

const deleteAgent = makeAgentLifecycleTool({
  name: "delete_agent",
  description: "Propose permanently deleting an agent.",
  summary: "Delete agent",
  action: "agent.deleted",
  applyAgent: (db, agentId) => agentService(db).remove(agentId),
});

const createRoutineTrigger = defineMutationTool({
  name: "create_routine_trigger",
  description: "Propose creating a new trigger for a routine.",
  parametersSchema: {
    type: "object",
    properties: {
      routineId: { type: "string" },
      kind: { type: "string", enum: ["schedule", "webhook", "api"] },
      label: { type: "string" },
      enabled: { type: "boolean" },
      cronExpression: { type: "string" },
      timezone: { type: "string" },
      signingMode: { type: "string" },
      replayWindowSec: { type: "number" },
    },
    required: ["routineId", "kind"],
    additionalProperties: false,
  },
  capability: "routines.write",
  buildPayload(params) {
    const routineId = nonEmptyString(params.routineId, "routineId");
    const input = createRoutineTriggerSchema.parse({
      kind: params.kind,
      label: params.label,
      enabled: params.enabled,
      cronExpression: params.cronExpression,
      timezone: params.timezone,
      signingMode: params.signingMode,
      replayWindowSec: params.replayWindowSec,
    });
    return {
      routineId,
      input,
    };
  },
  summarize(payload) {
    return `Create ${String((payload.input as Record<string, unknown>).kind)} trigger for routine ${String(payload.routineId)}`;
  },
  async apply(payload, ctx) {
    const routine = await routineService(ctx.db).get(String(payload.routineId));
    if (!routine || routine.companyId !== ctx.companyId) throw new Error("Routine not found");
    const created = await routineService(ctx.db).createTrigger(
      routine.id,
      payload.input as any,
      { userId: ctx.decidedByUserId, agentId: null },
    );
    await logBuilderAction(ctx, {
      action: "routine.trigger_created",
      entityType: "routine_trigger",
      entityId: created.trigger.id,
      details: { routineId: routine.id, kind: created.trigger.kind },
    });
    return {
      summary: `Routine trigger created`,
      entityId: created.trigger.id,
      entityType: "routine_trigger",
      details: {
        routineId: routine.id,
        trigger: created.trigger,
        secretMaterial: (created.secretMaterial as Record<string, unknown> | null) ?? null,
      },
      auditDetails: {
        routineId: routine.id,
        triggerId: created.trigger.id,
        kind: created.trigger.kind,
      },
    };
  },
});

const updateRoutineTrigger = defineMutationTool({
  name: "update_routine_trigger",
  description: "Propose updating a routine trigger.",
  parametersSchema: {
    type: "object",
    properties: {
      triggerId: { type: "string" },
      label: { type: "string" },
      enabled: { type: "boolean" },
      cronExpression: { type: "string" },
      timezone: { type: "string" },
      signingMode: { type: "string" },
      replayWindowSec: { type: "number" },
    },
    required: ["triggerId"],
    additionalProperties: false,
  },
  capability: "routines.write",
  buildPayload(params) {
    return {
      triggerId: nonEmptyString(params.triggerId, "triggerId"),
      patch: updateRoutineTriggerSchema.parse({
        label: params.label,
        enabled: params.enabled,
        cronExpression: params.cronExpression,
        timezone: params.timezone,
        signingMode: params.signingMode,
        replayWindowSec: params.replayWindowSec,
      }) as Record<string, unknown>,
    };
  },
  summarize(payload) {
    const fields = Object.keys(payload.patch as Record<string, unknown>).join(", ") || "no fields";
    return `Update routine trigger ${String(payload.triggerId)} (${fields})`;
  },
  async apply(payload, ctx) {
    const existing = await routineService(ctx.db).getTrigger(String(payload.triggerId));
    if (!existing || existing.companyId !== ctx.companyId) throw new Error("Routine trigger not found");
    const updated = await routineService(ctx.db).updateTrigger(
      existing.id,
      payload.patch as any,
      { userId: ctx.decidedByUserId, agentId: null },
    );
    if (!updated) throw new Error("Routine trigger not found");
    await logBuilderAction(ctx, {
      action: "routine.trigger_updated",
      entityType: "routine_trigger",
      entityId: updated.id,
      details: { routineId: updated.routineId, kind: updated.kind },
    });
    return {
      summary: `Routine trigger ${updated.id} updated`,
      entityId: updated.id,
      entityType: "routine_trigger",
    };
  },
});

const rotateRoutineTriggerSecret = defineMutationTool({
  name: "rotate_routine_trigger_secret",
  description: "Propose rotating the secret for a webhook routine trigger.",
  parametersSchema: {
    type: "object",
    properties: {
      triggerId: { type: "string" },
    },
    required: ["triggerId"],
    additionalProperties: false,
  },
  capability: "routines.write",
  buildPayload(params) {
    return { triggerId: nonEmptyString(params.triggerId, "triggerId") };
  },
  summarize(payload) {
    return `Rotate routine trigger secret ${String(payload.triggerId)}`;
  },
  async apply(payload, ctx) {
    const existing = await routineService(ctx.db).getTrigger(String(payload.triggerId));
    if (!existing || existing.companyId !== ctx.companyId) throw new Error("Routine trigger not found");
    const rotated = await routineService(ctx.db).rotateTriggerSecret(
      existing.id,
      { userId: ctx.decidedByUserId, agentId: null },
    );
    await logBuilderAction(ctx, {
      action: "routine.trigger_secret_rotated",
      entityType: "routine_trigger",
      entityId: rotated.trigger.id,
      details: { routineId: rotated.trigger.routineId },
    });
    return {
      summary: `Routine trigger secret rotated`,
      entityId: rotated.trigger.id,
      entityType: "routine_trigger",
      details: rotated.secretMaterial as unknown as Record<string, unknown>,
      auditDetails: {
        routineId: rotated.trigger.routineId,
        triggerId: rotated.trigger.id,
        kind: rotated.trigger.kind,
      },
    };
  },
});

const createInvite = defineMutationTool({
  name: "create_invite",
  description: "Propose creating a new company invite.",
  parametersSchema: {
    type: "object",
    properties: {
      allowedJoinTypes: { type: "string", enum: ["human", "agent", "both"] },
      humanRole: { type: "string", enum: ["owner", "admin", "operator", "viewer"] },
      defaultsPayload: { type: "object" },
      agentMessage: { type: "string" },
    },
    additionalProperties: false,
  },
  capability: "invites.write",
  buildPayload(params) {
    return createCompanyInviteSchema.parse({
      allowedJoinTypes: params.allowedJoinTypes,
      humanRole: params.humanRole,
      defaultsPayload: params.defaultsPayload,
      agentMessage: params.agentMessage,
    }) as unknown as Record<string, unknown>;
  },
  summarize(payload) {
    return `Create ${String(payload.allowedJoinTypes ?? "both")} invite`;
  },
  async apply(payload, ctx) {
    const created = await inviteService(ctx.db).create(
      ctx.companyId,
      payload as any,
      { userId: ctx.decidedByUserId },
    );
    await logBuilderAction(ctx, {
      action: "invite.created",
      entityType: "invite",
      entityId: created.invite.id,
      details: {
        inviteType: created.invite.inviteType,
        allowedJoinTypes: created.invite.allowedJoinTypes,
        expiresAt: created.invite.expiresAt.toISOString(),
        humanRole: created.humanRole,
        hasAgentMessage: Boolean(created.inviteMessage),
      },
    });
    return {
      summary: `Invite created`,
      entityId: created.invite.id,
      entityType: "invite",
      details: {
        inviteId: created.invite.id,
        token: created.token,
        invitePath: created.invitePath,
      },
      auditDetails: {
        inviteId: created.invite.id,
        invitePath: created.invitePath,
      },
    };
  },
});

const revokeInvite = defineMutationTool({
  name: "revoke_invite",
  description: "Propose revoking an existing invite.",
  parametersSchema: {
    type: "object",
    properties: {
      inviteId: { type: "string" },
    },
    required: ["inviteId"],
    additionalProperties: false,
  },
  capability: "invites.write",
  buildPayload(params) {
    return { inviteId: nonEmptyString(params.inviteId, "inviteId") };
  },
  summarize(payload) {
    return `Revoke invite ${String(payload.inviteId)}`;
  },
  async apply(payload, ctx) {
    const invite = await inviteService(ctx.db).getById(String(payload.inviteId));
    if (!invite || invite.companyId !== ctx.companyId) throw new Error("Invite not found");
    const revoked = await inviteService(ctx.db).revoke(invite.id);
    await logBuilderAction(ctx, {
      action: "invite.revoked",
      entityType: "invite",
      entityId: revoked.id,
      details: null,
    });
    return {
      summary: `Invite ${revoked.id} revoked`,
      entityId: revoked.id,
      entityType: "invite",
    };
  },
});

const approveApproval = defineMutationTool({
  name: "approve_approval",
  description: "Propose approving an existing approval request.",
  parametersSchema: {
    type: "object",
    properties: {
      approvalId: { type: "string" },
      decisionNote: { type: "string" },
    },
    required: ["approvalId"],
    additionalProperties: false,
  },
  capability: "approvals.write",
  buildPayload(params) {
    return {
      approvalId: nonEmptyString(params.approvalId, "approvalId"),
      decisionNote: stringOrNull(params.decisionNote),
    };
  },
  summarize(payload) {
    return `Approve approval ${String(payload.approvalId)}`;
  },
  async apply(payload, ctx) {
    const existing = await approvalService(ctx.db).getById(String(payload.approvalId));
    if (!existing || existing.companyId !== ctx.companyId) throw new Error("Approval not found");
    await assertApprovalIsNotLinkedBuilderGovernedFlow(ctx, existing.id);
    const result = await approvalService(ctx.db).approve(
      existing.id,
      ctx.decidedByUserId ?? "board",
      (payload.decisionNote as string | null) ?? null,
    );
    if (result.applied) {
      await logBuilderAction(ctx, {
        action: "approval.approved",
        entityType: "approval",
        entityId: result.approval.id,
        details: { type: result.approval.type },
      });
    }
    return {
      summary: `Approval ${result.approval.id} approved`,
      entityId: result.approval.id,
      entityType: "approval",
      details: { applied: result.applied, status: result.approval.status },
    };
  },
});

const rejectApproval = defineMutationTool({
  name: "reject_approval",
  description: "Propose rejecting an existing approval request.",
  parametersSchema: {
    type: "object",
    properties: {
      approvalId: { type: "string" },
      decisionNote: { type: "string" },
    },
    required: ["approvalId"],
    additionalProperties: false,
  },
  capability: "approvals.write",
  buildPayload(params) {
    return {
      approvalId: nonEmptyString(params.approvalId, "approvalId"),
      decisionNote: stringOrNull(params.decisionNote),
    };
  },
  summarize(payload) {
    return `Reject approval ${String(payload.approvalId)}`;
  },
  async apply(payload, ctx) {
    const existing = await approvalService(ctx.db).getById(String(payload.approvalId));
    if (!existing || existing.companyId !== ctx.companyId) throw new Error("Approval not found");
    await assertApprovalIsNotLinkedBuilderGovernedFlow(ctx, existing.id);
    const result = await approvalService(ctx.db).reject(
      existing.id,
      ctx.decidedByUserId ?? "board",
      (payload.decisionNote as string | null) ?? null,
    );
    if (result.applied) {
      await logBuilderAction(ctx, {
        action: "approval.rejected",
        entityType: "approval",
        entityId: result.approval.id,
        details: { type: result.approval.type },
      });
    }
    return {
      summary: `Approval ${result.approval.id} rejected`,
      entityId: result.approval.id,
      entityType: "approval",
      details: { applied: result.applied, status: result.approval.status },
    };
  },
});

const revokeAgentKey = defineMutationTool({
  name: "revoke_agent_key",
  description: "Propose revoking an agent API key.",
  parametersSchema: {
    type: "object",
    properties: {
      agentId: { type: "string" },
      keyId: { type: "string" },
    },
    required: ["agentId", "keyId"],
    additionalProperties: false,
  },
  capability: "agents.write",
  buildPayload(params) {
    return {
      agentId: nonEmptyString(params.agentId, "agentId"),
      keyId: nonEmptyString(params.keyId, "keyId"),
    };
  },
  summarize(payload) {
    return `Revoke agent key ${String(payload.keyId)}`;
  },
  async apply(payload, ctx) {
    const agent = await agentService(ctx.db).getById(String(payload.agentId));
    if (!agent || agent.companyId !== ctx.companyId) throw new Error("Agent not found");
    const key = await agentService(ctx.db).getKeyById(String(payload.keyId));
    if (!key || key.agentId !== agent.id || key.companyId !== ctx.companyId) {
      throw new Error("Agent key not found");
    }
    const revoked = await agentService(ctx.db).revokeKey(agent.id, key.id);
    if (!revoked) throw new Error("Agent key not found");
    await logBuilderAction(ctx, {
      action: "agent.key_revoked",
      entityType: "agent",
      entityId: agent.id,
      details: { keyId: revoked.id, name: revoked.name },
    });
    return {
      summary: `Agent key ${revoked.id} revoked`,
      entityId: agent.id,
      entityType: "agent",
    };
  },
});

const hireAgent = defineMutationTool({
  name: "hire_agent",
  description:
    "Propose hiring a new agent. Generates a hire approval that completes through the Approvals workflow.",
  parametersSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      role: { type: "string" },
      title: { type: "string" },
      reportsTo: { type: "string" },
      adapterType: { type: "string" },
      budgetMonthlyCents: { type: "number" },
      capabilities: { type: "string" },
    },
    required: ["name", "role", "adapterType"],
    additionalProperties: false,
  },
  capability: "agents.write",
  approvalType: "hire_agent",
  async buildPayload(params, ctx) {
    const reportsTo = stringOrNull(params.reportsTo);
    await assertAgentBelongsToCompany(ctx.db, ctx.companyId, reportsTo, "Manager agent");
    return {
      name: nonEmptyString(params.name, "name"),
      role: nonEmptyString(params.role, "role"),
      title: stringOrNull(params.title),
      reportsTo,
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
    return `Hire agent "${String(payload.name)}" as ${String(payload.role)} (adapter ${String(payload.adapterType)})`;
  },
  async apply() {
    return {
      summary: "Hire request sent to Approvals queue",
      entityType: "approval",
    };
  },
});

const setBudget = defineMutationTool({
  name: "set_budget",
  description:
    "Propose updating a budget policy. Goes through the standard Approvals workflow.",
  parametersSchema: {
    type: "object",
    properties: {
      scopeType: { type: "string", enum: ["company", "agent", "project"] },
      scopeId: { type: "string" },
      amountCents: { type: "number" },
      hardStopEnabled: { type: "boolean" },
    },
    required: ["scopeType", "scopeId", "amountCents"],
    additionalProperties: false,
  },
  capability: "budgets.write",
  approvalType: "set_budget",
  async buildPayload(params, ctx) {
    const scopeType = nonEmptyString(params.scopeType, "scopeType");
    const scopeId = scopeType === "company" ? ctx.companyId : nonEmptyString(params.scopeId, "scopeId");
    if (scopeType === "agent") {
      await assertAgentBelongsToCompany(ctx.db, ctx.companyId, scopeId, "Budget scope agent");
    }
    if (scopeType === "project") {
      await assertProjectBelongsToCompany(ctx.db, ctx.companyId, scopeId);
    }
    return {
      scopeType,
      scopeId,
      amountCents: finiteNonNegativeInteger(params.amountCents, "amountCents"),
      hardStopEnabled: typeof params.hardStopEnabled === "boolean" ? params.hardStopEnabled : true,
    };
  },
  summarize(payload) {
    return `Set ${String(payload.scopeType)} budget (${String(payload.scopeId)}) -> ${String(payload.amountCents)}c`;
  },
  async apply() {
    return {
      summary: "Budget policy request sent to Approvals queue",
      entityType: "approval",
    };
  },
});

const updateCompany = defineMutationTool({
  name: "update_company",
  description: "Propose updating company metadata.",
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
    if (typeof params.budgetMonthlyCents === "number" && Number.isFinite(params.budgetMonthlyCents) && params.budgetMonthlyCents >= 0) {
      patch.budgetMonthlyCents = Math.floor(params.budgetMonthlyCents);
    }
    if (Object.keys(patch).length === 0) {
      throw new Error("At least one of name, description, or budgetMonthlyCents must be provided");
    }
    return { patch };
  },
  summarize(payload) {
    return `Update company (${Object.keys(payload.patch as Record<string, unknown>).join(", ")})`;
  },
  async apply() {
    return {
      summary: "Company update request sent to Approvals queue",
      entityType: "approval",
    };
  },
});

const grantAccess = defineMutationTool({
  name: "grant_access",
  description:
    "Propose granting a user access to this company. Goes through the Approvals workflow.",
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
  async apply() {
    return {
      summary: "Access grant request sent to Approvals queue",
      entityType: "approval",
    };
  },
});

export function buildCoreMutationTools(): BuilderTool[] {
  return [
    addIssueComment,
    addApprovalComment,
    runRoutine,
    createRoutine,
    updateRoutine,
    createGoal,
    updateGoal,
    createIssue,
    updateIssue,
    createProject,
    updateProject,
    updateAgent,
    pauseAgent,
    resumeAgent,
    terminateAgent,
    deleteAgent,
    createRoutineTrigger,
    updateRoutineTrigger,
    rotateRoutineTriggerSecret,
    createInvite,
    revokeInvite,
    approveApproval,
    rejectApproval,
    revokeAgentKey,
    hireAgent,
    setBudget,
    updateCompany,
    grantAccess,
  ];
}

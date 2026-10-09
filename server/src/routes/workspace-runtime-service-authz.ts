import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import type { Request } from "express";
import { forbidden, notFound } from "../errors.js";
import { assertCompanyAccess, hasCompanyAccess } from "./authz.js";
import { parseProjectExecutionWorkspacePolicy } from "../services/execution-workspace-policy.js";
import { isLowTrustRuntimeManagementAllowed } from "../services/low-trust-runtime-containment.js";
import { resolveCoreTrustPreset, type TrustPresetResolution } from "../services/trust-preset-resolver.js";
import { WORKSPACE_RUNTIME_ELIGIBLE_ISSUE_STATUSES } from "../services/workspace-runtime-leases.js";
import { readObject } from "../lib/objects.js";

const WORKSPACE_RUNTIME_ELIGIBLE_ISSUE_STATUS_LIST: string[] = [...WORKSPACE_RUNTIME_ELIGIBLE_ISSUE_STATUSES];

/**
 * Identity of the actor authorized to drive a workspace runtime control, resolved once
 * so the durable runtime lease and the authorization decision agree on who is calling.
 */
export type WorkspaceRuntimeControlAuthorization = {
  actorType: string;
  agentId: string | null;
  runId: string | null;
  issueId: string | null;
};

function readRunIssueId(context: Record<string, unknown> | null) {
  const directIssueId = context?.issueId;
  if (typeof directIssueId === "string" && isUuidLike(directIssueId)) return directIssueId;
  const paperclipIssue = readObject(context?.paperclipIssue);
  const nestedIssueId = paperclipIssue?.id;
  return typeof nestedIssueId === "string" && isUuidLike(nestedIssueId) ? nestedIssueId : null;
}

async function listReportingSubtreeAgentIds(db: Db, companyId: string, actorAgentId: string) {
  const companyAgents = await db
    .select({
      id: agents.id,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

  const reportsByManager = new Map<string, string[]>();
  for (const agent of companyAgents) {
    if (!agent.reportsTo) continue;
    const reports = reportsByManager.get(agent.reportsTo) ?? [];
    reports.push(agent.id);
    reportsByManager.set(agent.reportsTo, reports);
  }

  const visited = new Set<string>([actorAgentId]);
  const queue = [actorAgentId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const reports = reportsByManager.get(current) ?? [];
    for (const reportId of reports) {
      if (visited.has(reportId)) continue;
      visited.add(reportId);
      queue.push(reportId);
    }
  }

  return [...visited];
}

async function assertAgentCanManageRuntimeServicesForWorkspace(
  db: Db,
  req: Request,
  input: {
    companyId: string;
    projectWorkspaceId?: string | null;
    executionWorkspaceId?: string | null;
    sourceIssueId?: string | null;
  },
): Promise<{ runIssueId: string | null }> {
  if (req.actor.type !== "agent" || !req.actor.agentId) {
    throw forbidden("Agent authentication required");
  }

  const actorAgent = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      role: agents.role,
      permissions: agents.permissions,
    })
    .from(agents)
    .where(eq(agents.id, req.actor.agentId))
    .then((rows) => rows[0] ?? null);

  if (!actorAgent || actorAgent.companyId !== input.companyId) {
    throw forbidden("Agent key cannot access another company");
  }

  const actorRun = req.actor.runId
    ? await db
        .select({
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.id, req.actor.runId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, actorAgent.id),
        ))
        .then((rows) => rows[0] ?? null)
    : null;
  const runContext = readObject(actorRun?.contextSnapshot);
  const runExecutionPolicy = readObject(runContext?.executionPolicy);

  const actorRuntimeTrust = assertLowTrustCanManageRuntimeForActor({
    companyId: input.companyId,
    actorAgent,
    runExecutionPolicy,
  });

  const runIssueId = readRunIssueId(runContext);

  if (actorAgent.role === "ceo" && actorRuntimeTrust.kind === "standard") {
    return { runIssueId };
  }

  const runScopedIssue = runIssueId
    ? await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          executionPolicy: issues.executionPolicy,
          projectExecutionWorkspacePolicy: projects.executionWorkspacePolicy,
        })
        .from(issues)
        .leftJoin(projects, and(eq(projects.id, issues.projectId), eq(projects.companyId, issues.companyId)))
        .where(and(
          eq(issues.id, runIssueId),
          eq(issues.companyId, input.companyId),
        ))
        .then((rows) => rows[0] ?? null)
    : null;

  if (runScopedIssue) {
    assertLowTrustCanManageRuntimeForIssue({
      actorAgent,
      issue: runScopedIssue,
      projectExecutionWorkspacePolicy: runScopedIssue.projectExecutionWorkspacePolicy,
      runExecutionPolicy,
    });
  }

  const workspaceScopeConditions = [
    input.projectWorkspaceId ? eq(issues.projectWorkspaceId, input.projectWorkspaceId) : null,
    input.executionWorkspaceId ? eq(issues.executionWorkspaceId, input.executionWorkspaceId) : null,
    input.sourceIssueId ? eq(issues.id, input.sourceIssueId) : null,
  ].filter((condition): condition is NonNullable<typeof condition> => condition !== null);

  if (workspaceScopeConditions.length === 0) {
    throw forbidden("Missing permission to manage workspace runtime services");
  }

  const workspaceScopeCondition = workspaceScopeConditions.length === 1
    ? workspaceScopeConditions[0]!
    : or(...workspaceScopeConditions);

  const linkedScopeIssues = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      projectId: issues.projectId,
      executionPolicy: issues.executionPolicy,
      projectExecutionWorkspacePolicy: projects.executionWorkspacePolicy,
    })
    .from(issues)
    .leftJoin(projects, and(eq(projects.id, issues.projectId), eq(projects.companyId, issues.companyId)))
    .where(and(
      eq(issues.companyId, input.companyId),
      isNull(issues.hiddenAt),
      inArray(issues.status, WORKSPACE_RUNTIME_ELIGIBLE_ISSUE_STATUS_LIST),
      workspaceScopeCondition,
    ));

  for (const linkedScopeIssue of linkedScopeIssues) {
    assertLowTrustCanManageRuntimeForIssue({
      actorAgent,
      issue: linkedScopeIssue,
      projectExecutionWorkspacePolicy: linkedScopeIssue.projectExecutionWorkspacePolicy,
      runExecutionPolicy,
    });
  }

  if (actorAgent.role === "ceo") {
    return { runIssueId };
  }

  const eligibleAgentIds = await listReportingSubtreeAgentIds(db, input.companyId, actorAgent.id);
  const linkedIssue = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      projectId: issues.projectId,
      executionPolicy: issues.executionPolicy,
      projectExecutionWorkspacePolicy: projects.executionWorkspacePolicy,
    })
    .from(issues)
    .leftJoin(projects, and(eq(projects.id, issues.projectId), eq(projects.companyId, issues.companyId)))
    .where(and(
      eq(issues.companyId, input.companyId),
      isNull(issues.hiddenAt),
      inArray(issues.status, WORKSPACE_RUNTIME_ELIGIBLE_ISSUE_STATUS_LIST),
      inArray(issues.assigneeAgentId, eligibleAgentIds),
      workspaceScopeCondition,
    ))
    .then((rows) => rows[0] ?? null);

  if (linkedIssue) {
    assertLowTrustCanManageRuntimeForIssue({
      actorAgent,
      issue: linkedIssue,
      projectExecutionWorkspacePolicy: linkedIssue.projectExecutionWorkspacePolicy,
      runExecutionPolicy,
    });
    return { runIssueId };
  }

  throw forbidden("Missing permission to manage workspace runtime services");
}

function assertLowTrustCanManageRuntimeForActor(input: {
  companyId: string;
  actorAgent: {
    id: string;
    companyId: string;
    permissions: unknown;
  };
  runExecutionPolicy?: unknown;
}): TrustPresetResolution {
  const resolution = resolveCoreTrustPreset({
    companyId: input.companyId,
    agent: {
      companyId: input.actorAgent.companyId,
      permissions: input.actorAgent.permissions,
    },
    run: input.runExecutionPolicy
      ? {
          companyId: input.companyId,
          executionPolicy: input.runExecutionPolicy,
        }
      : null,
  });
  if (resolution.kind === "denied") {
    throw forbidden(`Low-trust runtime service access denied: ${resolution.detail}`);
  }
  if (resolution.kind !== "low_trust_review") return resolution;
  if (isLowTrustRuntimeManagementAllowed(resolution)) return resolution;
  throw forbidden("Low-trust runs cannot manage workspace runtime services unless the boundary grants runtime.manage");
}

function assertLowTrustCanManageRuntimeForIssue(input: {
  actorAgent: {
    id: string;
    companyId: string;
    permissions: unknown;
  };
  issue: {
    id: string;
    companyId: string;
    projectId: string | null;
    executionPolicy: unknown;
  };
  projectExecutionWorkspacePolicy: unknown;
  runExecutionPolicy?: unknown;
}) {
  const resolution = resolveCoreTrustPreset({
    companyId: input.issue.companyId,
    agent: {
      companyId: input.actorAgent.companyId,
      permissions: input.actorAgent.permissions,
    },
    project: input.issue.projectId
      ? {
          companyId: input.issue.companyId,
          executionWorkspacePolicy: parseProjectExecutionWorkspacePolicy(input.projectExecutionWorkspacePolicy),
        }
      : null,
    issue: {
      companyId: input.issue.companyId,
      executionPolicy: input.issue.executionPolicy,
    },
    run: input.runExecutionPolicy
      ? {
          companyId: input.issue.companyId,
          executionPolicy: input.runExecutionPolicy,
        }
      : null,
  });
  if (resolution.kind === "denied") {
    throw forbidden(`Low-trust runtime service access denied: ${resolution.detail}`);
  }
  if (resolution.kind !== "low_trust_review") return;
  if (isLowTrustRuntimeManagementAllowed(resolution)) return;
  throw forbidden("Low-trust runs cannot manage workspace runtime services unless the boundary grants runtime.manage");
}

export async function assertCanManageProjectWorkspaceRuntimeServices(
  db: Db,
  req: Request,
  input: {
    companyId: string;
    projectWorkspaceId: string;
  },
) {
  if (!hasCompanyAccess(req, input.companyId)) {
    throw notFound("Project workspace not found");
  }
  assertCompanyAccess(req, input.companyId);
  if (req.actor.type === "board") return;
  await assertAgentCanManageRuntimeServicesForWorkspace(db, req, input);
}

export async function assertCanManageExecutionWorkspaceRuntimeServices(
  db: Db,
  req: Request,
  input: {
    companyId: string;
    executionWorkspaceId: string;
    sourceIssueId?: string | null;
  },
): Promise<WorkspaceRuntimeControlAuthorization> {
  if (!hasCompanyAccess(req, input.companyId)) {
    throw notFound("Execution workspace not found");
  }
  assertCompanyAccess(req, input.companyId);
  if (req.actor.type === "board") {
    return { actorType: "board", agentId: null, runId: null, issueId: null };
  }
  const { runIssueId } = await assertAgentCanManageRuntimeServicesForWorkspace(db, req, input);
  return {
    actorType: req.actor.type,
    agentId: req.actor.agentId ?? null,
    runId: req.actor.runId ?? null,
    issueId: runIssueId,
  };
}

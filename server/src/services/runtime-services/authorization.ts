import { and, eq, isNull } from "drizzle-orm";
import { agents, heartbeatRuns, issues, projects, principalPermissionGrants, type Db } from "@paperclipai/db";
import type { Request } from "express";
import { forbidden, notFound } from "../../errors.js";
import { assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { accessService } from "../access.js";
import { resolveCoreTrustPreset } from "../trust-preset-resolver.js";
import { isLowTrustRuntimeManagementAllowed } from "../low-trust-runtime-containment.js";
import type { RuntimeServiceActor } from "./manager.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Shared by HTTP and runner tools; provenance comes from the authenticated run. */
export async function authorizeRuntimeService(db: Db, req: Request, input: {
  companyId: string; issueId?: string | null; serviceId?: string; mutation?: boolean; creating?: boolean;
}): Promise<{ actor: RuntimeServiceActor; issueId: string | null; companyWide: boolean }> {
  assertCompanyAccess(req, input.companyId);
  const access = accessService(db);
  const allowed = await access.decide({
    actor: req.actor, action: input.mutation ? "runtime:manage" : "company_scope:read",
    resource: { type: "company", companyId: input.companyId },
  });
  if (!allowed.allowed) throw forbidden("Service access is outside this actor's authorization boundary");
  const info = getActorInfo(req);
  if (req.actor.type === "board") {
    if (input.issueId && !(await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))))[0]) throw notFound("Task not found");
    return { actor: { type: "board", id: info.actorId }, issueId: input.issueId ?? null, companyWide: true };
  }
  if (req.actor.type !== "agent" || !req.actor.agentId) throw forbidden();
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, req.actor.agentId), eq(agents.companyId, input.companyId)));
  if (!agent || ["terminated", "paused", "pending_approval", "error"].includes(agent.status)) throw forbidden("Agent cannot manage services in its current state");
  const [run] = req.actor.runId ? await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, req.actor.runId), eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.companyId, input.companyId),
  )) : [];
  if (req.actor.runId && (!run || !["running", "queued"].includes(run.status))) throw forbidden("Service tools require an active authenticated run");
  const snapshot = record(run?.contextSnapshot);
  const runIssueId = run?.nativeIssueId ?? (typeof snapshot.issueId === "string" ? snapshot.issueId : record(snapshot.paperclipIssue).id);
  const defaultIssueId = !input.serviceId && typeof runIssueId === "string" ? runIssueId : null;
  const issueId = input.creating && typeof runIssueId === "string" ? runIssueId : input.issueId ?? defaultIssueId;
  if (input.creating && input.issueId && runIssueId && input.issueId !== runIssueId) throw forbidden("Task provenance must match the authenticated run");
  const [task] = issueId ? await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId))) : [];
  if (issueId && !task) throw notFound("Task not found");
  if (input.mutation && task && task.workMode !== "standard") throw forbidden("Service mutations require a task in standard work mode");
  const [project] = task?.projectId ? await db.select().from(projects).where(and(eq(projects.id, task.projectId), eq(projects.companyId, input.companyId))) : [];
  const trust = resolveCoreTrustPreset({
    companyId: input.companyId, agent: { companyId: input.companyId, permissions: agent.permissions },
    run: run ? { companyId: input.companyId, executionPolicy: snapshot.executionPolicy } : null,
    issue: task ? { companyId: input.companyId, executionPolicy: task.executionPolicy } : null,
    project: project ? { companyId: input.companyId, executionWorkspacePolicy: project.executionWorkspacePolicy } : null,
  });
  if (trust.kind === "denied" || (trust.kind === "low_trust_review" && !isLowTrustRuntimeManagementAllowed(trust))) {
    throw forbidden("Execution policy does not grant service management");
  }
  // A role title is not a company-wide service grant. Broader authority must
  // be explicitly provisioned through the normal permission API.
  const [grant] = await db.select().from(principalPermissionGrants).where(and(
    eq(principalPermissionGrants.companyId, input.companyId), eq(principalPermissionGrants.principalType, "agent"),
    eq(principalPermissionGrants.principalId, agent.id), eq(principalPermissionGrants.permissionKey, "services:manage"),
    isNull(principalPermissionGrants.scope),
  ));
  const taskAllowed = task && (task.id === runIssueId || task.assigneeAgentId === agent.id);
  if (!grant && !taskAllowed) throw forbidden("Agent needs an authorized task or an explicit company service grant");
  return { actor: { type: "agent", id: agent.id, runId: run?.id ?? null }, issueId, companyWide: Boolean(grant) };
}

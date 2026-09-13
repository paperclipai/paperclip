import { and, eq } from "drizzle-orm";
import { agents, companyMemberships, heartbeatRuns, issues, projects, workFolderRuns, type Db } from "@paperclipai/db";
import type { WorkFolderOwner } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { authorizationService, type AuthorizationActor, type AuthorizationResource } from "./authorization.js";

/** Private-file access never inherits the responsible-user shadow-mode bypass. */
export async function assertWorkFolderAccess(db: Db, actor: AuthorizationActor, owner: WorkFolderOwner, write: boolean) {
  const deny = () => { throw notFound("Work folder not found"); };
  if (actor.type === "none") deny();
  if (actor.type === "agent" && actor.companyId !== owner.companyId) deny();
  if (actor.type === "board" && actor.source !== "local_implicit" && !actor.companyIds?.includes(owner.companyId)) deny();
  const userId = actor.type === "board" ? actor.userId : actor.onBehalfOfUserId;
  if (actor.source !== "local_implicit" && userId) {
    const [membership] = await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, owner.companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active")));
    if (!membership || (write && membership.membershipRole === "viewer")) deny();
  }
  if (owner.scope === "user") {
    if (!userId || userId !== owner.ownerId) deny();
    if (actor.type === "agent") {
      if (!actor.runId || !actor.agentId || actor.source !== "agent_jwt") deny();
      const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actor.runId!),
        eq(heartbeatRuns.companyId, owner.companyId), eq(heartbeatRuns.agentId, actor.agentId!)));
      const [binding] = await db.select().from(workFolderRuns).where(eq(workFolderRuns.runId, actor.runId!));
      if (!run || run.status !== "running" || run.responsibleUserId !== owner.ownerId
        || binding?.manifest.responsibleUserId !== owner.ownerId) deny();
    }
    return;
  }
  let resource: AuthorizationResource;
  let action: "issue:read" | "issue:mutate" | "agent:read" | "agent_config:update" | "project:read";
  if (owner.scope === "task") {
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, owner.ownerId), eq(issues.companyId, owner.companyId)));
    if (!issue) return deny();
    resource = { type: "issue", companyId: owner.companyId, issueId: issue.id, projectId: issue.projectId,
      parentIssueId: issue.parentId, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
      originKind: issue.originKind, originId: issue.originId, status: issue.status };
    action = write ? "issue:mutate" : "issue:read";
  } else if (owner.scope === "agent") {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, owner.ownerId), eq(agents.companyId, owner.companyId)));
    if (!agent) return deny();
    if (write && actor.type === "agent" && actor.agentId !== agent.id) deny();
    resource = { type: "agent", companyId: owner.companyId, agentId: agent.id };
    action = "agent:read";
  } else {
    const [project] = await db.select().from(projects).where(and(eq(projects.id, owner.ownerId), eq(projects.companyId, owner.companyId)));
    if (!project) return deny();
    resource = { type: "project", companyId: owner.companyId, projectId: project.id };
    action = "project:read";
  }
  const authz = authorizationService(db);
  if (!(await authz.decide({ actor, action, resource })).allowed) deny();
  if (actor.type === "agent" && userId) {
    const responsibleActor: AuthorizationActor = { type: "board", source: "session", userId,
      companyIds: [owner.companyId], memberships: actor.onBehalfOfMemberships, ignoreInstanceAdmin: true };
    if (!(await authz.decide({ actor: responsibleActor, action, resource })).allowed) deny();
  }
}

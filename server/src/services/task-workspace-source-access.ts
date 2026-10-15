import { executionWorkspaces, issues, type Db } from "@paperclipai/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { forbidden } from "../errors.js";
import { accessService } from "./access.js";
import { authorizationService, executionWorkspaceReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { canonicalExecutionUuid } from "./execution-identity.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type WorkspaceAccessContext = { write?: boolean; issueId?: string | null; parentIssueId?: string | null; assigneeAgentId?: string | null; assigneeUserId?: string | null };

export async function assertTaskWorkspaceSourceProjectAccess(
  db: Db | DbTransaction, actor: AuthorizationActor, companyId: string, projectId: string | null, options: WorkspaceAccessContext = {},
) {
  if (!projectId) return;
  const decision = await accessService(db as Db).decide({
    actor, action: "project:read", resource: { type: "project", companyId, projectId },
  });
  if (!decision.allowed) throw forbidden(decision.explanation);
  if (options.write) {
    const [task] = actor.type === "board" && options.issueId
      ? await db.select({ assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId }).from(issues)
        .where(and(eq(issues.id, options.issueId), eq(issues.companyId, companyId)))
      : [];
    const assigneeAgentId = actor.type === "agent" ? actor.agentId ?? null : task?.assigneeAgentId ?? options.assigneeAgentId ?? null;
    const assigneeUserId = actor.type === "agent" ? null : task?.assigneeUserId ?? options.assigneeUserId ?? null;
    const assignment = await accessService(db as Db).decide({
      actor, action: "project:write_workspace",
      resource: { type: "issue", companyId, projectId, assigneeAgentId, assigneeUserId,
        issueId: options.issueId, parentIssueId: options.parentIssueId },
      scope: { projectId, assigneeAgentId, assigneeUserId },
    });
    if (!assignment.allowed) throw forbidden(assignment.explanation);
  }
}

export async function assertTaskWorkspaceAccess(
  db: Db | DbTransaction, actor: AuthorizationActor, companyId: string, workspaceId: string, options: WorkspaceAccessContext = {},
) {
  const [workspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, workspaceId), eq(executionWorkspaces.companyId, companyId),
    await executionWorkspaceReadSqlCondition(db, actor),
  ));
  if (!workspace) throw forbidden("Task workspace access is no longer available");
  await assertTaskWorkspaceSourceProjectAccess(db, actor, companyId, workspace.projectId, { ...options, write: options.write && workspace.strategyType !== "git_worktree" });
  const retainedIssueIds = Object.keys(workspace.metadata?._issuePrivacySources ?? {});
  if (workspace.sourceIssueId) retainedIssueIds.push(workspace.sourceIssueId);
  const sources = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, companyId),
    or(eq(issues.executionWorkspaceId, workspaceId), retainedIssueIds.length > 0
      ? inArray(sql`${issues.id}`, retainedIssueIds.map(id => canonicalExecutionUuid(sql`${id}::text`))) : undefined),
  ));
  const sourceIds = new Set(sources.map(source => source.id));
  if (retainedIssueIds.some(id => !sourceIds.has(id))) throw forbidden("Task workspace source is no longer accessible");
  const access = accessService(db as Db);
  if (sources.length === 0 && !workspace.projectId) {
    const decision = await access.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId } });
    if (!decision.allowed) throw forbidden("An unscoped workspace is outside this actor's authorization boundary");
  }
  for (const source of sources) {
    const decision = await access.decide({ actor, action: "issue:read", resource: { type: "issue", companyId, issueId: source.id } });
    if (!decision.allowed) throw forbidden("Task workspace retains files outside this actor's authorization boundary");
  }
}

export async function assertTaskWorkspacesReadAccess(
  db: Db | DbTransaction, actor: AuthorizationActor, companyId: string, workspaceIds: Iterable<string>,
) {
  return assertTaskWorkspacesReadAccessForActors(db, [actor], companyId, workspaceIds);
}

export async function assertTaskWorkspacesReadAccessForActors(
  db: Db | DbTransaction, actors: AuthorizationActor[], companyId: string, workspaceIds: Iterable<string>,
) {
  const ids = [...new Set(workspaceIds)];
  if (!ids.length || !actors.length) return;
  const privacyActors = [...new Map(actors.map(actor => [JSON.stringify({ ...actor, runId: undefined }), actor])).values()];
  const privacy = and(...await Promise.all(privacyActors.map(actor => executionWorkspaceReadSqlCondition(db, actor))));
  const projectIds = new Set<string>(), sourceIds = new Set<string>();
  let needsCompanyRead = false;
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    const workspaces = await db.select({ id: executionWorkspaces.id, projectId: executionWorkspaces.projectId,
      sourceIssueId: executionWorkspaces.sourceIssueId, metadata: executionWorkspaces.metadata,
    }).from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, companyId), inArray(executionWorkspaces.id, batch), privacy));
    if (workspaces.length !== batch.length) throw forbidden("Task workspace access is no longer available");
    const retained = new Set(workspaces.flatMap(workspace => [
      ...Object.keys(workspace.metadata?._issuePrivacySources ?? {}), ...(workspace.sourceIssueId ? [workspace.sourceIssueId] : []),
    ]));
    const attached = await db.select({ id: issues.id, workspaceId: issues.executionWorkspaceId }).from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.executionWorkspaceId, batch)));
    const attachedWorkspaceIds = new Set(attached.map(source => source.workspaceId));
    for (const source of attached) sourceIds.add(source.id);
    const retainedIds = [...retained];
    for (let start = 0; start < retainedIds.length; start += 500) {
      const retainedBatch = retainedIds.slice(start, start + 500);
      const sources = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId),
        inArray(sql`${issues.id}`, retainedBatch.map(id => canonicalExecutionUuid(sql`${id}::text`)))));
      const found = new Set(sources.map(source => source.id));
      if (retainedBatch.some(id => !found.has(id))) throw forbidden("Task workspace source is no longer accessible");
      for (const source of sources) sourceIds.add(source.id);
    }
    for (const workspace of workspaces) {
      if (workspace.projectId) projectIds.add(workspace.projectId);
      else if (!workspace.sourceIssueId && !Object.keys(workspace.metadata?._issuePrivacySources ?? {}).length
        && !attachedWorkspaceIds.has(workspace.id)) needsCompanyRead = true;
    }
  }
  const resources = [
    ...[...projectIds].map(projectId => ({ type: "project" as const, companyId, projectId })),
    ...[...sourceIds].map(issueId => ({ type: "issue" as const, companyId, issueId })),
    ...(needsCompanyRead ? [{ type: "company" as const, companyId }] : []),
  ];
  const batches = await authorizationService(db).decideReadsForActors(actors, resources);
  for (const decisions of batches) for (let index = 0; index < decisions.length; index++) {
    if (decisions[index].allowed) continue;
    throw forbidden(resources[index].type === "issue"
      ? "Task workspace retains files outside this actor's authorization boundary"
      : resources[index].type === "company"
        ? "An unscoped workspace is outside this actor's authorization boundary" : decisions[index].explanation);
  }
}

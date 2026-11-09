import { measureRunPhase } from "./execution-preparation-timing.js";
import { agents, executionWorkspaces, heartbeatRuns, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { forbidden } from "../errors.js";
import { accessService } from "./access.js";
import { executionWorkspaceReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { assertSelectedWorkspaceTrust, runRetainsIssueIdentity, taskRepositoryRunColumns, taskRepositoryResponsibleUserMatches } from "./task-repository-acquisition.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { isDeepStrictEqual } from "node:util";
import { taskWorkspaceSelectionSchema, type TaskWorkspaceSelection } from "@paperclipai/shared";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function assertTaskWorkspaceSourceProjectAccess(
  db: Db | DbTransaction, actor: AuthorizationActor, companyId: string, projectId: string | null,
) {
  if (!projectId) return;
  const decision = await measureRunPhase("workspace.access.authorization", () => accessService(db as Db).decide({
    actor, action: "project:read", resource: { type: "project", companyId, projectId },
  }));
  if (!decision.allowed) throw forbidden(decision.explanation);
}

export async function assertExecutionWorkspaceRecordAccess(
  db: Db | DbTransaction, actor: AuthorizationActor, companyId: string, workspaceId: string,
) {
  const [workspace] = await measureRunPhase("workspace.access.inventory", async () => db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, workspaceId), eq(executionWorkspaces.companyId, companyId),
    await measureRunPhase("workspace.access.privacy", () => executionWorkspaceReadSqlCondition(db, actor)),
  )));
  if (!workspace) throw forbidden("Task workspace access is no longer available");
  await assertTaskWorkspaceSourceProjectAccess(db, actor, companyId, workspace.projectId);
  const retainedIssueIds = Object.keys(workspace.metadata?._issuePrivacySources ?? {});
  if (workspace.sourceIssueId) retainedIssueIds.push(workspace.sourceIssueId);
  const sources = await measureRunPhase("workspace.access.inventory", async () => db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, companyId),
    or(eq(issues.executionWorkspaceId, workspaceId), retainedIssueIds.length > 0
      ? inArray(sql`${issues.id}`, retainedIssueIds.map(id => canonicalExecutionUuid(sql`${id}::text`))) : undefined),
  )));
  const sourceIds = new Set(sources.map(source => source.id));
  if (retainedIssueIds.some(id => !sourceIds.has(id))) throw forbidden("Task workspace source is no longer accessible");
  const access = accessService(db as Db);
  if (sources.length === 0 && !workspace.projectId) {
    const decision = await measureRunPhase("workspace.access.authorization", () => access.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId } }));
    if (!decision.allowed) throw forbidden("An unscoped workspace is outside this actor's authorization boundary");
  }
  for (const source of sources) {
    const decision = await measureRunPhase("workspace.access.authorization", () => access.decide({ actor, action: "issue:read", resource: { type: "issue", companyId, issueId: source.id } }));
    if (!decision.allowed) throw forbidden("Workspace record contains task data outside this actor's authorization boundary");
  }
}

/** Authorize this task's selected execution inputs without classifying disk contents. */
export async function assertTaskWorkspaceExecutionAccess(
  db: Db | DbTransaction,
  actor: AuthorizationActor,
  companyId: string,
  input: { issueId: string; workspaceId?: string | null; projectWorkspaceId?: string | null; persistedSelection?: TaskWorkspaceSelection },
) {
  return measureRunPhase("workspace.access.execution", async () => {
    if (actor.companyId && actor.companyId !== companyId) throw forbidden("Task workspace belongs to another company");
    const [task] = await measureRunPhase("workspace.access.task_read", async () => db.select({
      id: issues.id, companyId: issues.companyId, projectId: issues.projectId,
      executionPolicy: issues.executionPolicy, executionWorkspaceId: issues.executionWorkspaceId,
      projectWorkspaceId: issues.projectWorkspaceId, workspaceSelection: issues.workspaceSelection,
      workspacePendingSelection: issues.workspacePendingSelection, workspaceBindingRevision: issues.workspaceBindingRevision,
    }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, companyId))));
    if (!task) throw forbidden("Task workspace task is unavailable");
    const access = accessService(db as Db);
    const [agent] = actor.type === "agent" && actor.agentId
      ? await measureRunPhase("workspace.access.agent_read", async () => db.select({ id: agents.id, companyId: agents.companyId, permissions: agents.permissions })
        .from(agents).where(and(eq(agents.id, actor.agentId!), eq(agents.companyId, companyId)))) : [];
    if (actor.type === "agent" && !agent) throw forbidden("Task workspace agent is unavailable");
    const [run] = actor.runId ? await measureRunPhase("workspace.access.run_read", async () => db.select(taskRepositoryRunColumns).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, actor.runId!), eq(heartbeatRuns.companyId, companyId)))) : [];
    if ((actor.source === "agent_jwt" && !actor.runId) || (actor.runId && (!run
      || run.agentId !== actor.agentId || !runRetainsIssueIdentity(run, task.id)))) {
      throw forbidden("Task workspace run identity is unavailable");
    }
    if (run && !taskRepositoryResponsibleUserMatches(actor.onBehalfOfUserId, run.responsibleUserId)) {
      throw forbidden("Task workspace responsible user changed");
    }
    const decision = await measureRunPhase("workspace.access.task_authorization", () => access.decide({ actor, action: "issue:read", resource: { type: "issue", companyId, issueId: task.id } }));
    if (!decision.allowed) throw forbidden(decision.explanation);
    const selection = task.workspaceSelection?.selection;
    const pending = task.workspacePendingSelection;
    const pendingSelection = pending?.expectedBindingRevision === task.workspaceBindingRevision ? pending.intent.selection : undefined;
    const effectiveSelection = input.persistedSelection !== undefined
      ? taskWorkspaceSelectionSchema.parse(input.persistedSelection) : undefined;
    if (effectiveSelection && (input.workspaceId != null || input.projectWorkspaceId != null
      || (!isDeepStrictEqual(effectiveSelection, selection) && !isDeepStrictEqual(effectiveSelection, pendingSelection)))) {
      throw forbidden("Task workspace selection is not a current persisted intent");
    }
    const workspaceId = effectiveSelection
      ? effectiveSelection.kind === "existing" ? effectiveSelection.workspaceId : null
      : input.workspaceId;
    const [workspace] = workspaceId ? await measureRunPhase("workspace.access.workspace_read", async () => db.select({
      id: executionWorkspaces.id, companyId: executionWorkspaces.companyId,
      projectId: executionWorkspaces.projectId, projectWorkspaceId: executionWorkspaces.projectWorkspaceId,
    }).from(executionWorkspaces).where(and(eq(executionWorkspaces.id, workspaceId), eq(executionWorkspaces.companyId, companyId)))) : [];
    if (workspaceId && (!workspace || (task.executionWorkspaceId !== workspace.id
      && !(selection?.kind === "existing" && selection.workspaceId === workspace.id)
      && !(pendingSelection?.kind === "existing" && pendingSelection.workspaceId === workspace.id)))) {
      throw forbidden("Task workspace binding is unavailable");
    }
    const selectedSourceId = effectiveSelection
      ? effectiveSelection.kind === "configured_source" ? effectiveSelection.projectWorkspaceId : workspace?.projectWorkspaceId ?? null
      : input.projectWorkspaceId ?? workspace?.projectWorkspaceId ?? task.projectWorkspaceId;
    if (input.projectWorkspaceId && input.projectWorkspaceId !== task.projectWorkspaceId
      && input.projectWorkspaceId !== workspace?.projectWorkspaceId
      && !(selection?.kind === "configured_source" && selection.projectWorkspaceId === input.projectWorkspaceId)
      && !(pendingSelection?.kind === "configured_source" && pendingSelection.projectWorkspaceId === input.projectWorkspaceId)) {
      throw forbidden("Task workspace source binding is unavailable");
    }
    const [source] = selectedSourceId ? await measureRunPhase("workspace.access.source_read", async () => db.select({ id: projectWorkspaces.id, projectId: projectWorkspaces.projectId })
      .from(projectWorkspaces).where(and(eq(projectWorkspaces.id, selectedSourceId), eq(projectWorkspaces.companyId, companyId)))) : [];
    if (selectedSourceId && !source) throw forbidden("Task workspace source is unavailable");
    const projectIds = [...new Set([task.projectId, workspace?.projectId, source?.projectId].filter((id): id is string => Boolean(id)))];
    const selectedProjects = projectIds.length ? await measureRunPhase("workspace.access.projects_read", async () => db.select({ id: projects.id, companyId: projects.companyId, executionWorkspacePolicy: projects.executionWorkspacePolicy })
      .from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)))) : [];
    if (selectedProjects.length !== projectIds.length) throw forbidden("Task workspace project is unavailable");
    for (const projectId of projectIds) await assertTaskWorkspaceSourceProjectAccess(db, actor, companyId, projectId);
    const sourceProjectId = source?.projectId ?? workspace?.projectId;
    const trust = resolveCoreTrustPreset({ companyId, agent, issue: task,
      project: selectedProjects.find(project => project.id === task.projectId),
      workspaceSourceProject: selectedProjects.find(project => project.id === sourceProjectId),
      run: run ? { companyId: run.companyId, executionPolicy: run.contextSnapshot?.executionPolicy } : null });
    if (trust.kind === "denied") throw forbidden(trust.detail);
    await measureRunPhase("workspace.access.trust", () => assertSelectedWorkspaceTrust(db, { companyId, actor, issueId: task.id,
      sourceProjectId: sourceProjectId ?? null, sourceWorkspaceId: effectiveSelection ? workspace?.id ?? null : workspace?.id }));
    return { task, workspace, source };
  });
}

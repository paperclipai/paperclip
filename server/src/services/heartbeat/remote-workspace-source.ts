import { asc, and, eq } from "drizzle-orm";
import { projectWorkspaces, type Db } from "@paperclipai/db";
import type { TaskWorkspaceIntent } from "@paperclipai/shared";
import { assertTaskWorkspaceExecutionAccess } from "../task-workspace-access.js";
import { managedProjectCheckoutName, projectRepositoryIdentity } from "../managed-project-checkout-name.js";
import { issueService } from "../issues.js";
import { projectService } from "../projects.js";
import { authorizationService } from "../authorization.js";
import { readRemoteWorkspaceAuthority, type RemoteWorkspaceSource } from "../remote-workspaces.js";
import { isMultiProjectWorkspaceSyncEnabled, isMultiProjectWorkspaceSyncRemoteEnabled,
  resolveRunReferencedProjects, WorkspaceValidationFailure, type ResolvedWorkspaceForRun } from "./workspaces.js";
import type { HeartbeatWorkspacePreparationInput } from "./workspace-preparation.js";

function assertRemoteRepositorySource(repoUrl: string) {
  const value = repoUrl.trim();
  let networkUrl = false;
  try {
    const parsed = new URL(value);
    networkUrl = ["https:", "http:", "ssh:", "git:", "git+ssh:"].includes(parsed.protocol) && Boolean(parsed.hostname);
  } catch { /* Git also accepts scp-style SSH sources. */ }
  const scpSource = !value.includes("://") && !/^file:/i.test(value) && !/^[a-z]:/i.test(value)
    && /^(?:[^@:/\s]+@)?(?:\[[a-f\d:]+\]|[a-z\d.-]+):[^:\s][^\r\n]*$/i.test(value);
  if (!networkUrl && !scpSource) throw new WorkspaceValidationFailure(
    "Import local repository folders before using them as remote workspace sources.",
    { reason: "remote_workspace_local_source_requires_import" });
}

/** Resolve an authorized source without materializing any controller directory. */
export async function resolveRemoteWorkspaceSource(db: Db, input: {
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  responsibleUserId: string | null;
  projectId: string | null;
  projectWorkspaceId: string | null;
  selection?: TaskWorkspaceIntent | null;
  existingWorkspace?: HeartbeatWorkspacePreparationInput["reuse"]["existingExecutionWorkspace"];
  taskDirectory?: boolean;
  ref?: string | null;
  branchName?: string | null;
  branchMode?: "create" | "existing";
}): Promise<{ source: RemoteWorkspaceSource; projectId: string | null; projectWorkspaceId: string | null;
  warnings?: string[]; referencedProjectFailures?: ResolvedWorkspaceForRun["referencedProjectFailures"] }> {
  const selected = await assertTaskWorkspaceExecutionAccess(db, {
    type: "agent", source: "agent_jwt", companyId: input.companyId,
    agentId: input.agentId, runId: input.runId,
    onBehalfOfUserId: input.responsibleUserId === "local-board" ? null : input.responsibleUserId,
  }, input.companyId, { issueId: input.issueId,
    ...(!input.selection && input.existingWorkspace ? { workspaceId: input.existingWorkspace.id } : {}),
    ...(input.selection ? { persistedSelection: input.selection.selection } : {}),
  });
  const withReferences = async (base: RemoteWorkspaceSource, anchorProjectId: string | null,
    sourceId: string | null) => {
    const extra: NonNullable<RemoteWorkspaceSource["repositories"]> =
      (base.repositories ?? []).filter(repository => !repository.readOnly);
    if (base.kind === "git") assertRemoteRepositorySource(base.repoUrl);
    for (const repository of extra) assertRemoteRepositorySource(repository.repoUrl);
    const referenced = isMultiProjectWorkspaceSyncEnabled() ? await resolveRunReferencedProjects(input.issueId, anchorProjectId, {
      companyId: input.companyId,
      actor: { type: "agent", source: "agent_jwt", companyId: input.companyId,
        agentId: input.agentId, runId: input.runId,
        onBehalfOfUserId: input.responsibleUserId === "local-board" ? null : input.responsibleUserId },
      issues: issueService(db), projects: projectService(db), access: authorizationService(db),
    }) : { additional: [], warnings: [], failures: [] };
    if (referenced.additional.length > 0) {
      if (!isMultiProjectWorkspaceSyncRemoteEnabled()) throw new WorkspaceValidationFailure(
        "Referenced remote workspace access is disabled.", { reason: "remote_referenced_workspace_disabled" });
      // Native sandbox providers currently run with external sandbox authority.
      // They cannot enforce a separate read-only filesystem root for a project.
      throw new WorkspaceValidationFailure("This remote runtime cannot safely provide read-only project folders.",
        { reason: "remote_workspace_readonly_sources_unsupported" });
    }
    return { source: { ...base, ...(extra.length ? { repositories: extra } : { repositories: undefined }) },
      projectId: anchorProjectId, projectWorkspaceId: sourceId,
      warnings: referenced.warnings, referencedProjectFailures: referenced.failures };
  };
  const existing = readRemoteWorkspaceAuthority(input.existingWorkspace?.metadata);
  if (existing) return withReferences(existing.source, input.existingWorkspace!.projectId,
    input.existingWorkspace!.projectWorkspaceId);
  if (input.existingWorkspace) throw new WorkspaceValidationFailure(
    "The existing workspace must be imported before it can use remote workspace storage.",
    { reason: "remote_workspace_migration_required" });
  if (input.taskDirectory || input.selection?.selection.kind === "task_directory") {
    return withReferences({ kind: "empty" }, null, null);
  }
  const projectId = selected.task.projectId;
  const sourceId = input.selection?.selection.kind === "configured_source"
    ? input.selection.selection.projectWorkspaceId : selected.source?.id ?? selected.task.projectWorkspaceId;
  const [source] = sourceId ? await db.select().from(projectWorkspaces).where(and(
    eq(projectWorkspaces.id, sourceId), eq(projectWorkspaces.companyId, input.companyId),
  )) : projectId ? await db.select().from(projectWorkspaces).where(and(
    eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.companyId, input.companyId),
  )).orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id)).limit(1) : [];
  if (!source) {
    if (sourceId || projectId) throw new WorkspaceValidationFailure(
      "The selected project has no repository source for a remote workspace.",
      { reason: "remote_workspace_source_unavailable" });
    return withReferences({ kind: "empty" }, null, null);
  }
  if (source.cwd && source.cwd !== "/__paperclip_repo_only__") throw new WorkspaceValidationFailure(
    "Import the configured local folder before using it as a remote workspace.",
    { reason: "remote_workspace_local_source_requires_import" });
  if (!source.repoUrl) throw new WorkspaceValidationFailure(
    "The selected workspace has no repository URL.", { reason: "remote_workspace_source_unavailable" });
  // Recheck authorization against the concrete configured source; the earliest
  // project default may have been selected after the initial task read.
  await assertTaskWorkspaceExecutionAccess(db, {
    type: "agent", source: "agent_jwt", companyId: input.companyId,
    agentId: input.agentId, runId: input.runId,
    onBehalfOfUserId: input.responsibleUserId === "local-board" ? null : input.responsibleUserId,
  }, input.companyId, { issueId: input.issueId,
    ...(selected.source ? { projectWorkspaceId: source.id } : {}),
  });
  const sameProject = await db.select().from(projectWorkspaces).where(and(
    eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, source.projectId),
  )).orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
  const repositories: NonNullable<RemoteWorkspaceSource["repositories"]> = [];
  const identities = new Set([projectRepositoryIdentity(source.repoUrl)]);
  for (const repository of sameProject) {
    if (!repository.repoUrl || identities.has(projectRepositoryIdentity(repository.repoUrl))) continue;
    if (repository.cwd && repository.cwd !== "/__paperclip_repo_only__") throw new WorkspaceValidationFailure(
      "Import configured local repository folders before using remote workspace storage.",
      { reason: "remote_workspace_local_source_requires_import" });
    identities.add(projectRepositoryIdentity(repository.repoUrl));
    repositories.push({ id: repository.id, relativePath: `.paperclip-repositories/${managedProjectCheckoutName({
      id: repository.id, repoUrl: repository.repoUrl, repoRef: repository.repoRef,
    })}`, repoUrl: repository.repoUrl, ref: repository.repoRef, projectId: source.projectId,
      projectWorkspaceId: repository.id });
  }
  return withReferences({ kind: "git", repoUrl: source.repoUrl,
    ref: input.ref ?? source.repoRef ?? source.defaultRef ?? null,
    ...(input.branchName ? { branchName: input.branchName } : {}),
    ...(input.branchMode ? { branchMode: input.branchMode } : {}),
    ...(repositories.length ? { repositories } : {}),
  }, source.projectId, source.id);
}

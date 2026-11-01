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

function remoteRepositorySource(repoUrl: string): boolean {
  const value = repoUrl.trim();
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new WorkspaceValidationFailure(
    "The repository source is invalid.", { reason: "remote_workspace_source_invalid" });
  if (/^[a-z]:/i.test(value) || /^file:/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (["https:", "http:", "ssh:", "git:", "git+ssh:"].includes(parsed.protocol) && parsed.hostname) return true;
  } catch { /* Git also accepts scp-style SSH sources and local paths. */ }
  if (!value.includes("://") && /^(?:[^@:/\s]+@)?(?:\[[a-f\d:]+\]|[a-z\d.-]+):[^:\s][^\r\n]*$/i.test(value)) return true;
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) return false;
  throw new WorkspaceValidationFailure("The repository source is invalid.", { reason: "remote_workspace_source_invalid" });
}

type RemoteWorkspaceSourceResolution = { authority: "remote"; source: RemoteWorkspaceSource;
  projectId: string | null; projectWorkspaceId: string | null; warnings?: string[];
  referencedProjectFailures?: ResolvedWorkspaceForRun["referencedProjectFailures"] } | { authority: "host" };

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
  configuredCwd?: string | null;
  automaticEnrollment?: boolean;
  ref?: string | null;
  branchName?: string | null;
  branchMode?: "create" | "existing";
}): Promise<RemoteWorkspaceSourceResolution> {
  const selected = await assertTaskWorkspaceExecutionAccess(db, {
    type: "agent", source: "agent_jwt", companyId: input.companyId,
    agentId: input.agentId, runId: input.runId,
    onBehalfOfUserId: input.responsibleUserId === "local-board" ? null : input.responsibleUserId,
  }, input.companyId, { issueId: input.issueId,
    ...(!input.selection && input.existingWorkspace ? { workspaceId: input.existingWorkspace.id } : {}),
    ...(input.selection ? { persistedSelection: input.selection.selection } : {}),
  });
  const hostSource = (): { authority: "host" } => {
    if (input.automaticEnrollment) return { authority: "host" };
    throw new WorkspaceValidationFailure("Import local repository folders before using them as remote workspace sources.",
      { reason: "remote_workspace_local_source_requires_import" });
  };
  const withReferences = async (base: RemoteWorkspaceSource, anchorProjectId: string | null,
    sourceId: string | null, savedSource = false): Promise<RemoteWorkspaceSourceResolution> => {
    const extra: NonNullable<RemoteWorkspaceSource["repositories"]> =
      (base.repositories ?? []).filter(repository => !repository.readOnly);
    // A verified saved archive owns these files after import. Its original Git
    // source remains an identity and need not be reachable from the new sandbox.
    if (!savedSource) {
      if (base.kind === "git" && !remoteRepositorySource(base.repoUrl)) return hostSource();
      for (const repository of extra) if (!remoteRepositorySource(repository.repoUrl)) return hostSource();
    }
    const referenced = isMultiProjectWorkspaceSyncEnabled() ? await resolveRunReferencedProjects(input.issueId, anchorProjectId, {
      companyId: input.companyId,
      actor: { type: "agent", source: "agent_jwt", companyId: input.companyId,
        agentId: input.agentId, runId: input.runId,
        onBehalfOfUserId: input.responsibleUserId === "local-board" ? null : input.responsibleUserId },
      issues: issueService(db), projects: projectService(db), access: authorizationService(db),
    }) : { additional: [], warnings: [], failures: [] };
    const sourceLess = referenced.additional.filter(({ project }) => Array.isArray(project.workspaces) && project.workspaces.length === 0);
    if (referenced.additional.length > sourceLess.length) {
      if (!isMultiProjectWorkspaceSyncRemoteEnabled()) throw new WorkspaceValidationFailure(
        "Referenced remote workspace access is disabled.", { reason: "remote_referenced_workspace_disabled" });
      // Native sandbox providers currently run with external sandbox authority.
      // They cannot enforce a separate read-only filesystem root for a project.
      throw new WorkspaceValidationFailure("This remote runtime cannot safely provide read-only project folders.",
        { reason: "remote_workspace_readonly_sources_unsupported" });
    }
    return { authority: "remote", source: { ...base, ...(extra.length ? { repositories: extra } : { repositories: undefined }) },
      projectId: anchorProjectId, projectWorkspaceId: sourceId,
      warnings: [...referenced.warnings, ...sourceLess.map(({ projectId }) =>
        `Referenced project ${projectId} has no configured workspace source; no project folder was attached.`)],
      referencedProjectFailures: [...referenced.failures, ...sourceLess.map(({ projectId }) =>
        ({ projectId, reason: "resolution" as const }))] };
  };
  const existing = readRemoteWorkspaceAuthority(input.existingWorkspace?.metadata);
  if (existing) return withReferences(existing.source, input.existingWorkspace!.projectId,
    input.existingWorkspace!.projectWorkspaceId, existing.snapshotId !== null);
  if (input.existingWorkspace && input.automaticEnrollment) return { authority: "host" };
  if (input.existingWorkspace) throw new WorkspaceValidationFailure(
    "The existing workspace must be imported before it can use remote workspace storage.",
    { reason: "remote_workspace_migration_required" });
  if (input.taskDirectory || input.selection?.selection.kind === "task_directory") {
    return withReferences({ kind: "empty" }, null, null);
  }
  if (input.configuredCwd) return hostSource();
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
  // Recheck authorization against the concrete configured source; the earliest
  // project default may have been selected after the initial task read.
  await assertTaskWorkspaceExecutionAccess(db, {
    type: "agent", source: "agent_jwt", companyId: input.companyId,
    agentId: input.agentId, runId: input.runId,
    onBehalfOfUserId: input.responsibleUserId === "local-board" ? null : input.responsibleUserId,
  }, input.companyId, { issueId: input.issueId,
    ...(selected.source ? { projectWorkspaceId: source.id } : {}),
  });
  if (source.sourceType === "remote_managed") return hostSource();
  if (source.cwd && source.cwd !== "/__paperclip_repo_only__") return hostSource();
  if (!source.repoUrl) throw new WorkspaceValidationFailure(
    "The selected workspace has no repository URL.", { reason: "remote_workspace_source_unavailable" });
  if (!remoteRepositorySource(source.repoUrl)) return hostSource();
  const sameProject = await db.select().from(projectWorkspaces).where(and(
    eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, source.projectId),
  )).orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
  const repositories: NonNullable<RemoteWorkspaceSource["repositories"]> = [];
  const identities = new Set([projectRepositoryIdentity(source.repoUrl)]);
  for (const repository of sameProject) {
    if (!repository.repoUrl || identities.has(projectRepositoryIdentity(repository.repoUrl))) continue;
    if (repository.sourceType === "remote_managed") return hostSource();
    if (repository.cwd && repository.cwd !== "/__paperclip_repo_only__") return hostSource();
    if (!remoteRepositorySource(repository.repoUrl)) return hostSource();
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

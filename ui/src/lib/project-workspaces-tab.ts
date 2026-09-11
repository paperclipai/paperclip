import type { ExecutionWorkspace, Issue, Project, ProjectWorkspace } from "@paperclipai/shared";

type ProjectWorkspaceLike = Pick<Project, "workspaces" | "primaryWorkspace">;

export type ProjectWorkspaceLinkedIssue = Pick<Issue, "id" | "identifier" | "title" | "updatedAt"> & {
  status: string;
  priority: string;
  description?: string | null;
  blockerAttention?: Issue["blockerAttention"];
  projectId?: string | null;
  project?: Issue["project"];
  originKind?: Issue["originKind"];
  originId?: string | null;
};

export type WorkspaceTargetKind = "repository" | "remote_operator" | "artifact_only" | "unconfigured";

export interface WorkspaceTargetProvenance {
  kind: WorkspaceTargetKind;
  authoritativePath: string | null;
  checkoutRoot: string | null;
  deliveryMethod: string;
  fingerprint: string | null;
  lastAttestation: string | null;
  configurationIncomplete: boolean;
  repairHref: string;
}

export interface ProjectWorkspaceSummary {
  key: string;
  kind: "execution_workspace" | "project_workspace";
  workspaceId: string;
  workspaceName: string;
  cwd: string | null;
  branchName: string | null;
  lastUpdatedAt: Date;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  executionWorkspaceStatus: ExecutionWorkspace["status"] | null;
  serviceCount: number;
  runningServiceCount: number;
  primaryServiceUrl: string | null;
  primaryServiceUrlRunning: boolean;
  hasRuntimeConfig: boolean;
  linkedIssueCount: number;
  issues: ProjectWorkspaceLinkedIssue[];
  target?: WorkspaceTargetProvenance;
}

// repoUrl/providerRef/remoteWorkspaceRef are typed as unrestricted strings with no runtime
// shape validation, so there's no fixed set of "credential patterns" to deny — any opaque
// value could in principle be a raw secret. Rather than trying to deny known-bad shapes
// (which can never be complete), allow only known-safe non-URL shapes through verbatim and
// redact everything else by default.
const SCP_STYLE_REMOTE = /^[\w.-]+@[\w.-]+:.+$/; // e.g. git@github.com:org/repo.git
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/|~\/)/; // e.g. /mnt/artifacts/run-42, C:\work, ~/work
// A bare alnum/dash/dot/underscore string is structurally indistinguishable from a raw
// secret token (e.g. a GitHub PAT) — shape alone can't vouch for it. Only trust this shape
// verbatim when the caller confirms the value came from a platform-managed provider
// reference (sandbox/environment ids the system itself generates), never from a
// user-suppliable field like a plain repoUrl.
const OPAQUE_TOKEN_ID = /^[A-Za-z0-9._-]+$/;

function redactRemote(value: string | null | undefined, options?: { allowOpaqueToken?: boolean }): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.host) {
      // A real authority component means the WHATWG parser already split out
      // username/password separately from host; reconstructing protocol+host+pathname
      // can't carry them forward.
      return `${url.protocol}//${url.host}${url.pathname}`;
    }
    // Opaque-path form (no "//" authority, e.g. a bare "scheme:user:secret@host/path" git
    // remote) — the parser accepts this but never decomposes userinfo, leaving it sitting
    // unchanged in pathname, so fall through to the allowlist check below instead of
    // trusting this as already-safe.
  } catch {
    // Not URL-shaped at all — same fallthrough.
  }

  if (SCP_STYLE_REMOTE.test(trimmed) || ABSOLUTE_PATH.test(trimmed)) {
    return trimmed;
  }
  if (options?.allowOpaqueToken && OPAQUE_TOKEN_ID.test(trimmed)) {
    return trimmed;
  }
  // Doesn't match any known-safe shape — could be an arbitrary credential-bearing value,
  // so redact it rather than trust it by default.
  return "(redacted)";
}

// Project workspaces are only "unconfigured" when they're the primary workspace on a
// local_path source with no remote declared — a project owner must still pick a target.
// Non-primary local_path workspaces without a remote are treated as artifact-only, since
// they're expected to hold generated/derived content rather than an authoritative checkout.
function targetForProjectWorkspace(workspace: ProjectWorkspace): WorkspaceTargetProvenance {
  const hasRemote = Boolean(workspace.repoUrl || workspace.remoteWorkspaceRef);
  const hasRepository = workspace.sourceType === "git_repo" || (workspace.sourceType === "local_path" && hasRemote);
  const configurationIncomplete = workspace.isPrimary && workspace.sourceType === "local_path" && !hasRemote;
  return {
    kind: hasRepository ? "repository" : workspace.sourceType === "remote_managed" ? "remote_operator" : configurationIncomplete ? "unconfigured" : "artifact_only",
    authoritativePath: redactRemote(workspace.repoUrl ?? workspace.remoteWorkspaceRef, {
      allowOpaqueToken: workspace.sourceType === "remote_managed",
    }),
    checkoutRoot: workspace.cwd,
    deliveryMethod: workspace.sourceType === "remote_managed" ? "remote/operator" : hasRepository ? "repository checkout" : "artifact-only",
    fingerprint: null,
    lastAttestation: null,
    configurationIncomplete,
    repairHref: "",
  };
}

export type ExecutionWorkspaceTargetSource = Pick<
  ExecutionWorkspace,
  "strategyType" | "repoUrl" | "cwd" | "providerType" | "providerRef"
>;

// Execution workspaces derive "repository" from strategyType alone for git_worktree (the
// worktree checkout root itself proves the target), but non-worktree strategies (e.g.
// project_primary, cloud_sandbox) still need a repository/provider ref check because they
// can be backed by a repo checkout without using the worktree strategy. adapter_managed
// providers are "remote_operator" targets even without a repoUrl, since the operator/sandbox
// reference is the authoritative identity — a providerRef on any *other* provider type isn't
// established as authoritative for anything (the `kind` derivation below doesn't treat it as
// one), so it must not count towards "has a reference" either; otherwise a workspace can be
// marked configured while `kind` still resolves to `artifact_only`, hiding the case the
// completeness check exists to catch. project_primary is the execution-workspace analog of a
// project workspace's primary folder (it operates directly on shared/primary content rather
// than an isolated worktree or sandbox), so — mirroring targetForProjectWorkspace's isPrimary
// check — a project_primary workspace with no repository and no adapter-managed provider is
// genuinely unconfigured and must warn, even though it will almost always still have a cwd.
// Non-primary strategies (e.g. cloud_sandbox) without either are legitimately artifact-only
// by design and don't need a repair prompt.
export function targetForExecutionWorkspace(
  workspace: ExecutionWorkspaceTargetSource,
  repairHref: string,
): WorkspaceTargetProvenance {
  const hasRepository = workspace.strategyType === "git_worktree" || Boolean(workspace.repoUrl);
  const isOperatorManaged = workspace.providerType === "adapter_managed";
  const hasAnyReference = hasRepository || isOperatorManaged;
  const configurationIncomplete = workspace.strategyType === "project_primary" && !hasAnyReference;
  return {
    kind: hasRepository ? "repository" : isOperatorManaged ? "remote_operator" : configurationIncomplete ? "unconfigured" : "artifact_only",
    authoritativePath: redactRemote(workspace.repoUrl ?? workspace.providerRef, { allowOpaqueToken: isOperatorManaged }),
    checkoutRoot: workspace.cwd,
    deliveryMethod: hasRepository ? "repository checkout" : isOperatorManaged ? "remote/operator" : "artifact-only",
    fingerprint: null,
    lastAttestation: null,
    configurationIncomplete,
    repairHref,
  };
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function maxDate(...values: Array<Date | string | null | undefined>): Date {
  let latest = new Date(0);
  for (const value of values) {
    const date = toDate(value);
    if (date && date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

function primaryWorkspaceId(project: ProjectWorkspaceLike): string | null {
  return project.primaryWorkspace?.id
    ?? project.workspaces.find((workspace) => workspace.isPrimary)?.id
    ?? project.workspaces[0]?.id
    ?? null;
}

function isDefaultSharedExecutionWorkspace(input: {
  executionWorkspace: ExecutionWorkspace;
  issue: Issue;
  primaryWorkspaceId: string | null;
}) {
  const linkedProjectWorkspaceId =
    input.executionWorkspace.projectWorkspaceId ?? input.issue.projectWorkspaceId ?? null;
  return input.executionWorkspace.mode === "shared_workspace" && linkedProjectWorkspaceId === input.primaryWorkspaceId;
}

function runtimeServiceSummary(
  services: NonNullable<ExecutionWorkspace["runtimeServices"]> | undefined,
) {
  const serviceCount = services?.length ?? 0;
  const runningServiceCount = services?.filter((service) => service.status === "running").length ?? 0;
  const primaryService =
    services?.find((service) => service.status === "running" && service.url)
    ?? services?.find((service) => service.url)
    ?? null;

  return {
    serviceCount,
    runningServiceCount,
    primaryServiceUrl: primaryService?.url ?? null,
    primaryServiceUrlRunning: primaryService?.status === "running",
  };
}

export function buildProjectWorkspaceSummaries(input: {
  project: ProjectWorkspaceLike;
  issues: Issue[];
  executionWorkspaces: ExecutionWorkspace[];
}): ProjectWorkspaceSummary[] {
  const primaryId = primaryWorkspaceId(input.project);
  const executionWorkspacesById = new Map(
    input.executionWorkspaces.map((workspace) => [workspace.id, workspace] as const),
  );
  const projectWorkspacesById = new Map(
    input.project.workspaces.map((workspace) => [workspace.id, workspace] as const),
  );
  const summaries = new Map<string, ProjectWorkspaceSummary>();

  for (const issue of input.issues) {
    if (issue.executionWorkspaceId) {
      const executionWorkspace = executionWorkspacesById.get(issue.executionWorkspaceId);
      if (!executionWorkspace) continue;
      if (executionWorkspace.status === "archived") continue;
      if (isDefaultSharedExecutionWorkspace({
        executionWorkspace,
        issue,
        primaryWorkspaceId: primaryId,
      })) continue;

      const existing = summaries.get(`execution:${executionWorkspace.id}`);
      const nextIssues = [...(existing?.issues ?? []), issue].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      const runtimeSummary = runtimeServiceSummary(executionWorkspace.runtimeServices);

      summaries.set(`execution:${executionWorkspace.id}`, {
        key: `execution:${executionWorkspace.id}`,
        kind: "execution_workspace",
        workspaceId: executionWorkspace.id,
        workspaceName: executionWorkspace.name,
        cwd: executionWorkspace.cwd ?? null,
        branchName: executionWorkspace.branchName ?? executionWorkspace.baseRef ?? null,
        lastUpdatedAt: maxDate(
          existing?.lastUpdatedAt,
          executionWorkspace.lastUsedAt,
          executionWorkspace.updatedAt,
          issue.updatedAt,
        ),
        projectWorkspaceId: executionWorkspace.projectWorkspaceId ?? issue.projectWorkspaceId ?? null,
        executionWorkspaceId: executionWorkspace.id,
        executionWorkspaceStatus: executionWorkspace.status,
        ...runtimeSummary,
        hasRuntimeConfig: Boolean(
          executionWorkspace.config?.workspaceRuntime
          ?? projectWorkspacesById.get(executionWorkspace.projectWorkspaceId ?? issue.projectWorkspaceId ?? "")?.runtimeConfig?.workspaceRuntime,
        ),
        linkedIssueCount: nextIssues.length,
        issues: nextIssues,
        target: targetForExecutionWorkspace(executionWorkspace, `/execution-workspaces/${executionWorkspace.id}/configuration`),
      });
      continue;
    }

    if (!issue.projectWorkspaceId || issue.projectWorkspaceId === primaryId) continue;
    const projectWorkspace = projectWorkspacesById.get(issue.projectWorkspaceId);
    if (!projectWorkspace) continue;

    const existing = summaries.get(`project:${projectWorkspace.id}`);
    const nextIssues = [...(existing?.issues ?? []), issue].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    const runtimeSummary = runtimeServiceSummary(projectWorkspace.runtimeServices);

    summaries.set(`project:${projectWorkspace.id}`, {
      key: `project:${projectWorkspace.id}`,
      kind: "project_workspace",
      workspaceId: projectWorkspace.id,
      workspaceName: projectWorkspace.name,
      cwd: projectWorkspace.cwd ?? null,
      branchName: projectWorkspace.repoRef ?? projectWorkspace.defaultRef ?? null,
      lastUpdatedAt: maxDate(existing?.lastUpdatedAt, projectWorkspace.updatedAt, issue.updatedAt),
      projectWorkspaceId: projectWorkspace.id,
      executionWorkspaceId: null,
      executionWorkspaceStatus: null,
      ...runtimeSummary,
      hasRuntimeConfig: Boolean(projectWorkspace.runtimeConfig?.workspaceRuntime),
      linkedIssueCount: nextIssues.length,
      issues: nextIssues,
      target: targetForProjectWorkspace(projectWorkspace),
    });
  }

  for (const projectWorkspace of input.project.workspaces) {
    const key = `project:${projectWorkspace.id}`;
    if (summaries.has(key)) continue;
    const shouldSurfaceWorkspace =
      projectWorkspace.isPrimary
      || Boolean(projectWorkspace.runtimeConfig?.workspaceRuntime)
      || (projectWorkspace.runtimeServices?.length ?? 0) > 0;
    if (!shouldSurfaceWorkspace) continue;
    const runtimeSummary = runtimeServiceSummary(projectWorkspace.runtimeServices);
    summaries.set(key, {
      key,
      kind: "project_workspace",
      workspaceId: projectWorkspace.id,
      workspaceName: projectWorkspace.name,
      cwd: projectWorkspace.cwd ?? null,
      branchName: projectWorkspace.repoRef ?? projectWorkspace.defaultRef ?? null,
      lastUpdatedAt: maxDate(projectWorkspace.updatedAt),
      projectWorkspaceId: projectWorkspace.id,
      executionWorkspaceId: null,
      executionWorkspaceStatus: null,
      ...runtimeSummary,
      hasRuntimeConfig: Boolean(projectWorkspace.runtimeConfig?.workspaceRuntime),
      linkedIssueCount: 0,
      issues: [],
      target: targetForProjectWorkspace(projectWorkspace),
    });
  }

  return [...summaries.values()].sort((a, b) => {
    const liveDiff = Number(b.runningServiceCount > 0) - Number(a.runningServiceCount > 0);
    if (liveDiff !== 0) return liveDiff;
    const diff = b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime();
    return diff !== 0 ? diff : a.workspaceName.localeCompare(b.workspaceName);
  });
}

import type {
  Environment,
  EnvironmentLease,
  ExecutionWorkspaceConfig,
  WorkspaceRealizationRecord,
  WorkspaceRealizationRequest,
} from "@paperclipai/shared";
import type { RealizedExecutionWorkspace } from "./workspace-runtime.js";

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readWorkspaceRealizationRequest(value: unknown): WorkspaceRealizationRequest | null {
  const parsed = parseObject(value);
  if (parsed.version !== 1) return null;
  const source = parseObject(parsed.source);
  const runtimeOverlay = parseObject(parsed.runtimeOverlay);
  const localPath = readString(source.localPath);
  const companyId = readString(parsed.companyId);
  const environmentId = readString(parsed.environmentId);
  const heartbeatRunId = readString(parsed.heartbeatRunId);
  const adapterType = readString(parsed.adapterType);
  if (!localPath || !companyId || !environmentId || !heartbeatRunId || !adapterType) return null;

  return {
    version: 1,
    adapterType,
    companyId,
    environmentId,
    executionWorkspaceId: readString(parsed.executionWorkspaceId),
    issueId: readString(parsed.issueId),
    heartbeatRunId,
    requestedMode: readString(parsed.requestedMode),
    source: {
      kind:
        source.kind === "task_session" || source.kind === "agent_home"
          ? source.kind
          : "project_primary",
      localPath,
      projectId: readString(source.projectId),
      projectWorkspaceId: readString(source.projectWorkspaceId),
      repoUrl: readString(source.repoUrl),
      repoRef: readString(source.repoRef),
      strategy: source.strategy === "git_worktree" ? "git_worktree" : "project_primary",
      branchName: readString(source.branchName),
      worktreePath: readString(source.worktreePath),
    },
    runtimeOverlay: {
      provisionCommand: readString(runtimeOverlay.provisionCommand),
      teardownCommand: readString(runtimeOverlay.teardownCommand),
      cleanupCommand: readString(runtimeOverlay.cleanupCommand),
      workspaceRuntime: Object.keys(parseObject(runtimeOverlay.workspaceRuntime)).length > 0
        ? parseObject(runtimeOverlay.workspaceRuntime)
        : null,
    },
  };
}

export function buildWorkspaceRealizationRequest(input: {
  adapterType: string;
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  issueId: string | null;
  heartbeatRunId: string;
  requestedMode: string | null;
  workspace: RealizedExecutionWorkspace;
  workspaceConfig: ExecutionWorkspaceConfig | null;
}): WorkspaceRealizationRequest {
  return {
    version: 1,
    adapterType: input.adapterType,
    companyId: input.companyId,
    environmentId: input.environmentId,
    executionWorkspaceId: input.executionWorkspaceId,
    issueId: input.issueId,
    heartbeatRunId: input.heartbeatRunId,
    requestedMode: input.requestedMode,
    source: {
      kind: input.workspace.source,
      localPath: input.workspace.cwd,
      projectId: input.workspace.projectId,
      projectWorkspaceId: input.workspace.workspaceId,
      repoUrl: input.workspace.repoUrl,
      repoRef: input.workspace.repoRef,
      strategy: input.workspace.strategy,
      branchName: input.workspace.branchName,
      worktreePath: input.workspace.worktreePath,
    },
    runtimeOverlay: {
      provisionCommand: input.workspaceConfig?.provisionCommand ?? null,
      teardownCommand: input.workspaceConfig?.teardownCommand ?? null,
      cleanupCommand: input.workspaceConfig?.cleanupCommand ?? null,
      workspaceRuntime: input.workspaceConfig?.workspaceRuntime ?? null,
    },
  };
}

export function buildWorkspaceRealizationRecord(input: {
  environment: Environment;
  lease: EnvironmentLease;
  request: WorkspaceRealizationRequest;
  realizedCwd?: string | null;
  providerMetadata?: Record<string, unknown> | null;
}): WorkspaceRealizationRecord {
  const leaseMetadata = input.lease.metadata ?? {};
  const providerMetadata = input.providerMetadata ?? {};
  const transport =
    input.environment.driver === "ssh" || input.environment.driver === "sandbox" || input.environment.driver === "plugin"
      ? input.environment.driver
      : "local";
  const remotePath =
    readString(providerMetadata.remoteCwd) ??
    readString(leaseMetadata.remoteCwd) ??
    readString(providerMetadata.remotePath) ??
    null;
  const host = readString(leaseMetadata.host);
  const port = readNumber(leaseMetadata.port);
  const username = readString(leaseMetadata.username);
  const sandboxId = readString(leaseMetadata.sandboxId) ?? readString(providerMetadata.sandboxId);

  const sync = (() => {
    if (transport === "local") {
      return {
        strategy: "none" as const,
        prepare: "Use the realized local execution workspace directly.",
        syncBack: null,
      };
    }
    if (transport === "ssh") {
      return {
        strategy: "ssh_git_import_export" as const,
        prepare: "Import the local git workspace to the remote SSH workspace before adapter execution.",
        syncBack: "Export remote SSH workspace changes back to the local execution workspace after adapter execution.",
      };
    }
    if (transport === "sandbox") {
      return {
        strategy: "sandbox_archive_upload_download" as const,
        prepare: "Upload a workspace archive into the sandbox filesystem before adapter execution.",
        syncBack: "Download a workspace archive from the sandbox and mirror it back locally after adapter execution.",
      };
    }
    return {
      strategy: "provider_defined" as const,
      prepare: "Delegate workspace materialization to the plugin environment driver.",
      syncBack: "Delegate result synchronization to the plugin environment driver.",
    };
  })();

  const provider =
    input.lease.provider ??
    (transport === "ssh" ? "ssh" : transport === "local" ? "local" : null);
  const localPath = input.request.source.localPath;
  const summary =
    transport === "local"
      ? `Local workspace realized at ${localPath}.`
      : transport === "ssh"
        ? `SSH workspace realized at ${username ?? "user"}@${host ?? "host"}:${port ?? 22}:${remotePath ?? input.request.source.localPath}.`
        : transport === "sandbox"
          ? `Sandbox workspace realized at ${remotePath ?? "/"}${sandboxId ? ` in ${sandboxId}` : ""}.`
          : `Plugin workspace realized at ${input.realizedCwd ?? remotePath ?? localPath}.`;

  return {
    version: 1,
    transport,
    provider,
    environmentId: input.environment.id,
    leaseId: input.lease.id,
    providerLeaseId: input.lease.providerLeaseId,
    local: {
      path: localPath,
      source: input.request.source.kind,
      strategy: input.request.source.strategy,
      projectId: input.request.source.projectId,
      projectWorkspaceId: input.request.source.projectWorkspaceId,
      repoUrl: input.request.source.repoUrl,
      repoRef: input.request.source.repoRef,
      branchName: input.request.source.branchName,
      worktreePath: input.request.source.worktreePath,
    },
    remote: {
      path: remotePath,
      ...(host ? { host } : {}),
      ...(port ? { port } : {}),
      ...(username ? { username } : {}),
      ...(sandboxId ? { sandboxId } : {}),
    },
    sync,
    bootstrap: {
      command: input.request.runtimeOverlay.provisionCommand,
    },
    rebuild: {
      executionWorkspaceId: input.request.executionWorkspaceId,
      mode: input.request.requestedMode,
      repoUrl: input.request.source.repoUrl,
      repoRef: input.request.source.repoRef,
      localPath,
      remotePath,
      providerLeaseId: input.lease.providerLeaseId,
      metadata: {
        source: input.request.source,
        runtimeOverlay: input.request.runtimeOverlay,
        environmentDriver: input.environment.driver,
        provider,
        providerMetadata,
      },
    },
    summary,
  };
}

export function buildWorkspaceRealizationRecordFromDriverInput(input: {
  environment: Environment;
  lease: EnvironmentLease;
  workspace: {
    localPath?: string;
    remotePath?: string;
    mode?: string;
    metadata?: Record<string, unknown>;
  };
  cwd?: string | null;
  providerMetadata?: Record<string, unknown> | null;
}): WorkspaceRealizationRecord {
  const request =
    readWorkspaceRealizationRequest(input.workspace.metadata?.workspaceRealizationRequest) ??
    readWorkspaceRealizationRequest(input.workspace.metadata?.request) ??
    buildWorkspaceRealizationRequest({
      adapterType: "unknown",
      companyId: input.lease.companyId,
      environmentId: input.environment.id,
      executionWorkspaceId: input.lease.executionWorkspaceId,
      issueId: input.lease.issueId,
      heartbeatRunId: input.lease.heartbeatRunId ?? "unknown",
      requestedMode: input.workspace.mode ?? null,
      workspace: {
        baseCwd: input.workspace.localPath ?? input.cwd ?? input.workspace.remotePath ?? "/",
        source: "task_session",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        cwd: input.workspace.localPath ?? input.cwd ?? input.workspace.remotePath ?? "/",
        branchName: null,
        worktreePath: null,
        warnings: [],
        created: false,
      },
      workspaceConfig: null,
    });

  return buildWorkspaceRealizationRecord({
    environment: input.environment,
    lease: input.lease,
    request,
    realizedCwd: input.cwd ?? null,
    providerMetadata: input.providerMetadata,
  });
}

import { isRollingWebDeployment } from "./controller-rolling-deployment.js";
import { createHash } from "node:crypto";
import { remoteWorkspaceAuthoritySchema, remoteWorkspaceRunReferenceSchema } from "../../packages/shared/src/remote-workspace.js";
import type { ExecutionWorkspace, WorkspaceFileContent } from "../../packages/shared/src/index.js";
import type { StoryCheck, StoryRun } from "./everyday-observations.js";
import type { MatrixExecution } from "./types.js";
import type { RunnerApi } from "./api.js";

type RunSummary = Pick<StoryRun, "runtimeMode" | "status" | "agentId" | "finishedAt"> & { runId: string };

export const REMOTE_WORKSPACE_STORAGE_SUITE = "remote-workspace-storage";
export const REMOTE_WORKSPACE_PROOF_FILE = "workspace-proof.txt";

export interface RemoteWorkspaceStorageCheckpoint {
  workspaceId: string;
  snapshotId: string;
  runId: string;
  runSnapshotId: string;
  runSaveState: string;
  authoritySchema: string;
  authorityDirty: boolean;
  authorityWriter: string | null;
  providerType: string;
  proofSha256: string;
  fileSource: string;
}

export interface RemoteWorkspaceStorageEvidence {
  initial?: RemoteWorkspaceStorageCheckpoint;
  final?: RemoteWorkspaceStorageCheckpoint;
  browserReadPhases: string[];
  upgradeReadiness?: { version: number; activeRuns: number; recoverableRuns: number; truncated: boolean };
}

export function isRemoteWorkspaceStorageExecution(execution: MatrixExecution): boolean {
  return execution.suite.id === REMOTE_WORKSPACE_STORAGE_SUITE || isRollingWebDeployment(execution);
}

export function remoteWorkspaceStoragePrompt(base: string): string {
  return `${base.replace("Work in the project workspace.", "Work in this task's own workspace.")} This is synthetic test work. Initialize a Git repository in the task workspace if it does not have one. Commit the initial source and README locally; do not push to any external repository. Create ${REMOTE_WORKSPACE_PROOF_FILE} containing a fresh random 32-character lowercase hexadecimal reference, with a trailing newline. Generate the reference inside the task, do not print its value in chat, and leave this file untracked. Keep this exact file and the local commit through later revisions; do not recreate or replace the reference.`;
}

export function remoteWorkspaceProofDigest(content: string): string {
  if (!/^[a-f0-9]{32}\n$/.test(content)) throw new Error("Remote workspace proof must contain its original generated synthetic reference");
  return createHash("sha256").update(content).digest("hex");
}

export async function readRemoteWorkspaceStorageCheckpoint(input: {
  api: Pick<RunnerApi, "get">; companyId: string; agentId: string; issueId: string; environmentId: string;
}): Promise<{ point?: RemoteWorkspaceStorageCheckpoint; content?: string }> {
  const view = await input.api.get<{ issueId: string; workspace: ExecutionWorkspace | null }>(`/api/issues/${input.issueId}/workspace`);
  const workspace = view.workspace;
  const authorityResult = remoteWorkspaceAuthoritySchema.safeParse(workspace?.metadata?.remoteWorkspace);
  if (view.issueId !== input.issueId || !workspace || workspace.companyId !== input.companyId
    || workspace.providerType !== "cloud_sandbox" || !authorityResult.success) return {};
  const authority = authorityResult.data;
  if (!authority.snapshotId || authority.dirty || authority.writerRunId || !authority.location
    || authority.location.environmentId !== input.environmentId) return {};
  const runs = await input.api.get<RunSummary[]>(`/api/issues/${input.issueId}/runs`);
  const latest = runs.filter(run => run.runtimeMode === "native" && run.status === "succeeded"
    && run.agentId === input.agentId && typeof run.runId === "string")
    .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0];
  if (!latest) return {};
  const run = await input.api.get<StoryRun>(`/api/heartbeat-runs/${encodeURIComponent(latest.runId)}`);
  if (run.id !== latest.runId || run.companyId !== input.companyId || run.agentId !== input.agentId
    || run.nativeIssueId !== input.issueId || run.runtimeMode !== "native" || run.status !== "succeeded") return {};
  const receiptResult = remoteWorkspaceRunReferenceSchema.safeParse(run.runnerProfileJson?.remoteWorkspace);
  if (!receiptResult.success) return {};
  const receipt = receiptResult.data;
  if (receipt.state !== "saved" || receipt.snapshotId !== authority.snapshotId
    || receipt.workspaceId !== workspace.id || receipt.epoch !== authority.epoch
    || receipt.leaseId !== authority.location.leaseId || receipt.providerLeaseId !== authority.location.providerLeaseId
    || receipt.remoteCwd !== authority.location.remoteCwd) return {};
  const file = await input.api.get<WorkspaceFileContent>(`/api/issues/${input.issueId}/file-resources/content?workspace=execution&path=${REMOTE_WORKSPACE_PROOF_FILE}`);
  if (file.content?.encoding !== "utf8" || typeof file.content.data !== "string") throw new Error("Remote workspace file oracle did not return text bytes");
  if (file.resource?.source?.kind !== "live" || file.resource.workspaceKind !== "execution_workspace"
    || file.resource.workspaceId !== workspace.id) return {};
  return { content: file.content.data, point: {
    workspaceId: workspace.id, snapshotId: authority.snapshotId, runId: run.id,
    runSnapshotId: receipt.snapshotId, runSaveState: receipt.state,
    authoritySchema: authority.schema, authorityDirty: authority.dirty,
    authorityWriter: authority.writerRunId, providerType: workspace.providerType,
    proofSha256: remoteWorkspaceProofDigest(file.content.data), fileSource: file.resource?.source?.kind,
  } };
}

export function gradeRemoteWorkspaceStorage(evidence: RemoteWorkspaceStorageEvidence): StoryCheck[] {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const committed = (point: RemoteWorkspaceStorageCheckpoint | undefined) => Boolean(point
    && uuid.test(point.workspaceId) && uuid.test(point.snapshotId) && uuid.test(point.runId)
    && point.snapshotId === point.runSnapshotId && point.runSaveState === "saved"
    && point.authoritySchema === "paperclip.remote-workspace.v1" && point.authorityDirty === false
    && point.authorityWriter === null && point.providerType === "cloud_sandbox"
    && point.fileSource === "live" && /^[a-f0-9]{64}$/.test(point.proofSha256));
  return [
    { id: "remote-workspace-initial-save", passed: committed(evidence.initial), detail: "The initial task admission commits a remote workspace snapshot and a matching saved run receipt." },
    { id: "remote-workspace-final-save", passed: committed(evidence.final), detail: "The later admission commits its files before finalization succeeds." },
    { id: "remote-workspace-proof-retained", passed: Boolean(committed(evidence.initial) && committed(evidence.final)
      && evidence.initial!.workspaceId === evidence.final!.workspaceId
      && evidence.initial!.runId !== evidence.final!.runId
      && evidence.initial!.snapshotId !== evidence.final!.snapshotId
      && evidence.initial!.proofSha256 === evidence.final!.proofSha256),
      detail: "The same remote workspace retains its generated untracked reference through controller replacement and later native admission." },
    { id: "remote-workspace-browser-read", passed: ["before-restart", "after-restart"].every(phase => evidence.browserReadPhases.includes(phase)),
      detail: "Ordinary browser file navigation renders the independently read workspace reference before and after controller replacement." },
    { id: "remote-workspace-upgrade-recoverable", passed: Boolean(evidence.upgradeReadiness
      && evidence.upgradeReadiness.version === 1 && evidence.upgradeReadiness.truncated === false
      && Number.isSafeInteger(evidence.upgradeReadiness.activeRuns)
      && Number.isSafeInteger(evidence.upgradeReadiness.recoverableRuns)
      && evidence.upgradeReadiness.activeRuns >= 1 && evidence.upgradeReadiness.recoverableRuns >= 1
      && evidence.upgradeReadiness.recoverableRuns <= evidence.upgradeReadiness.activeRuns),
      detail: "The ordinary instance upgrade probe recognizes an active remote workspace execution as recoverable before controller replacement." },
  ];
}

/** Only this explicit synthetic workflow can opt the isolated server into S3. */
export function remoteWorkspaceStorageServerEnvironment(input: {
  executions: readonly MatrixExecution[];
  env: NodeJS.ProcessEnv;
  instanceId: string;
}): NodeJS.ProcessEnv | undefined {
  if (!input.executions.some(isRemoteWorkspaceStorageExecution)) return undefined;
  if (!input.executions.length || !input.executions.every(isRemoteWorkspaceStorageExecution)) {
    throw new Error("Remote workspace storage qualification must run alone");
  }
  const bucket = input.env.PAPERCLIP_RUNNER_E2E_WORKSPACE_STORAGE_BUCKET?.trim();
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("Remote workspace storage requires an explicit disposable S3 bucket");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(input.instanceId)) throw new Error("Invalid isolated instance identity");
  const endpoint = input.env.PAPERCLIP_RUNNER_E2E_WORKSPACE_STORAGE_ENDPOINT?.trim();
  if (endpoint) {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Remote workspace storage endpoint must not contain credentials");
    }
  }
  return {
    PAPERCLIP_STORAGE_PROVIDER: "s3",
    PAPERCLIP_STORAGE_S3_BUCKET: bucket,
    PAPERCLIP_STORAGE_S3_REGION: input.env.PAPERCLIP_RUNNER_E2E_WORKSPACE_STORAGE_REGION?.trim() || "us-east-1",
    PAPERCLIP_STORAGE_S3_PREFIX: `runner-e2e/${input.instanceId}/`,
    ...(endpoint ? { PAPERCLIP_STORAGE_S3_ENDPOINT: endpoint,
      PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE: input.env.PAPERCLIP_RUNNER_E2E_WORKSPACE_STORAGE_FORCE_PATH_STYLE === "true" ? "true" : "false" } : {}),
  };
}

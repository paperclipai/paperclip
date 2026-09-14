import path from "node:path";
import { and, eq } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { parseObject } from "../../adapters/utils.js";
import type { RealizedExecutionWorkspace } from "../workspace-runtime.js";
import { toExecutionWorkspace } from "../execution-workspaces.js";
import { withRuntimeServiceLeaseLock, assertRuntimeServiceLeaseDataAvailable } from "../runtime-services/retention.js";
import { sameRuntimeServiceConfiguration } from "../runtime-services/run-attachment.js";
import { runtimeServiceTaskWorkspace } from "../runtime-services/task-workspace.js";
import type { NativeRestartRecoveryClaim } from "./native-restart-recovery.js";
import { NativeRunnerOwnershipUnverifiedError } from "./native-runner-ownership.js";
import { remoteRunnerRecoveryProcess } from "./remote-runner-recovery.js";
import { inspectNativeWorkspaceSyncHost, readNativeWorkspaceSyncReference, restoreNativeWorkspaceSyncHost } from "./native-workspace-sync.js";

export function nativeRemoteRestartProcess(claim?: NativeRestartRecoveryClaim) {
  return claim?.kind === "reattach_existing_runner" && claim.process.processLocation === "remote" ? claim.process : null;
}

/** Recover the active run on its existing lease; idle prior-run takeover is separate. */
export function canDispatchNativeRemoteRestart(run: Pick<typeof heartbeatRuns.$inferSelect, "runtimeMode" | "runnerProfileJson">): boolean {
  try {
    const mode = parseNativeExecutionInput(parseObject(run.runnerProfileJson).nativeExecutionInput).session.lifecyclePolicy.mode;
    return run.runtimeMode === "native" && (mode === "per_turn" || mode === "warm");
  } catch { return false; }
}

type DispatchInput = { db: Db; run: typeof heartbeatRuns.$inferSelect; claim: NativeRestartRecoveryClaim };

/** Read-only preflight; environment admission checks current execution policy. */
export async function prepareNativeRemoteDispatch(input: DispatchInput) {
  return resolveNativeRemoteDispatch(input, false);
}

/** Called only after the original remote target has been recovered and bound to
 * this controller. Rechecks all ownership before materializing a missing mirror. */
export async function restoreNativeRemoteDispatchWorkspace(input: DispatchInput) {
  return resolveNativeRemoteDispatch(input, true);
}

async function resolveNativeRemoteDispatch(input: DispatchInput, restoreHost: boolean) {
  const unavailable = (): never => { throw new NativeRunnerOwnershipUnverifiedError("remote_runner_reattachment_unavailable"); };
  const process = nativeRemoteRestartProcess(input.claim);
  if (!process || input.claim.runId !== input.run.id || !canDispatchNativeRemoteRestart(input.run)) return unavailable();
  const execution = parseNativeExecutionInput(parseObject(input.run.runnerProfileJson).nativeExecutionInput);
  if (execution.binding.runId !== input.run.id || execution.binding.companyId !== input.run.companyId
    || execution.binding.agentId !== input.run.agentId || execution.binding.issueId !== input.run.nativeIssueId
    || execution.session.normalizedSessionId !== input.run.nativeSessionId) return unavailable();
  const [initial] = await input.db.select().from(environmentLeases).where(and(eq(environmentLeases.id, process.environmentLeaseId),
    eq(environmentLeases.companyId, input.run.companyId), eq(environmentLeases.heartbeatRunId, input.run.id)));
  if (!initial) return unavailable();
  return withRuntimeServiceLeaseLock(input.db, initial, async tx => {
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.run.id), eq(heartbeatRuns.companyId, input.run.companyId)));
    const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, initial.id), eq(environmentLeases.companyId, input.run.companyId)));
    const [owner] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, input.run.id), eq(nativeRunFinalizations.companyId, input.run.companyId)));
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, execution.binding.issueId), eq(issues.companyId, input.run.companyId)));
    if (!run || !lease || !owner || !issue || owner.leaseOwner !== input.claim.leaseOwner || owner.controllerGeneration !== input.claim.controllerGeneration
      || !owner.leaseExpiresAt || owner.leaseExpiresAt.getTime() <= Date.now() || owner.issueId !== execution.binding.issueId
      || issue.executionRunId !== run.id || issue.assigneeAgentId !== run.agentId || ["done", "cancelled"].includes(issue.status)
      || !sameRuntimeServiceConfiguration(remoteRunnerRecoveryProcess(lease, run), process)
      || !sameRuntimeServiceConfiguration(parseObject(run.runnerProfileJson).nativeExecutionInput, execution)) return unavailable();
    await assertRuntimeServiceLeaseDataAvailable(tx, lease);
    const sync = readNativeWorkspaceSyncReference(parseObject(run.runnerProfileJson).nativeWorkspaceSync);
    if (!sync || sync.workspaceId !== execution.binding.executionWorkspaceId || sync.leaseId !== lease.id
      || sync.providerLeaseId !== lease.providerLeaseId || sync.remoteCwd !== process.workspaceRoot) return unavailable();
    let hostState: "present" | "missing" | "recovering";
    try {
      const inspected = await inspectNativeWorkspaceSyncHost({ runId: run.id, reference: sync });
      const { descriptor } = inspected;
      if (descriptor.binding.companyId !== run.companyId || path.resolve(descriptor.binding.localCwd) !== path.resolve(execution.workspace.cwd)) return unavailable();
      hostState = inspected.hostState;
    } catch { return unavailable(); }
    let workspace: ExecutionWorkspace | null = null;
    if (lease.executionWorkspaceId) {
      const [row] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, lease.executionWorkspaceId), eq(executionWorkspaces.companyId, run.companyId)));
      if (!row || !row.cwd || row.id !== execution.binding.executionWorkspaceId || row.status === "archived"
        || path.resolve(row.cwd) !== path.resolve(execution.workspace.cwd)) return unavailable();
      workspace = toExecutionWorkspace(row);
    } else {
      const attached = await runtimeServiceTaskWorkspace(tx as unknown as Db, run.companyId, issue.id);
      if (attached ? attached.binding.id !== execution.binding.executionWorkspaceId || path.resolve(attached.binding.hostCwd) !== path.resolve(execution.workspace.cwd)
        : execution.binding.executionWorkspaceId !== run.id) return unavailable();
    }
    if (restoreHost && hostState !== "present") {
      const assertAuthorized = async () => {
        const [currentRun] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
        const [currentOwner] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId)));
        const [currentIssue] = await tx.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.companyId, run.companyId)));
        const [currentLease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, run.companyId)));
        if (workspace) {
          const [currentWorkspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, workspace.id), eq(executionWorkspaces.companyId, run.companyId)));
          if (!currentWorkspace || currentWorkspace.status === "archived" || currentWorkspace.cwd !== workspace.cwd) return unavailable();
        }
        if (!currentRun || !currentOwner || !currentIssue || currentOwner.leaseOwner !== input.claim.leaseOwner
          || currentOwner.controllerGeneration !== input.claim.controllerGeneration || !currentOwner.leaseExpiresAt
          || currentOwner.leaseExpiresAt.getTime() <= Date.now() || currentIssue.executionRunId !== run.id
          || currentIssue.assigneeAgentId !== run.agentId || ["done", "cancelled"].includes(currentIssue.status)
          || !currentLease || !sameRuntimeServiceConfiguration(remoteRunnerRecoveryProcess(currentLease, currentRun), process)
          || !sameRuntimeServiceConfiguration(readNativeWorkspaceSyncReference(parseObject(currentRun.runnerProfileJson).nativeWorkspaceSync), sync)
          || !sameRuntimeServiceConfiguration(parseObject(currentRun.runnerProfileJson).nativeExecutionInput, execution)) return unavailable();
      };
      try {
        const reference = await restoreNativeWorkspaceSyncHost({ runId: run.id, reference: sync, assertAuthorized });
        // Lock only publication, so long local reads cannot extend an expired
        // controller claim. Any ownership change leaves the attested copy held.
        await tx.select().from(issues).where(eq(issues.id, issue.id)).for("update");
        const [latest] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("update");
        await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)).for("update");
        await assertAuthorized();
        if (!latest) return unavailable();
        await tx.update(heartbeatRuns).set({ runnerProfileJson: { ...parseObject(latest.runnerProfileJson), nativeWorkspaceSync: reference },
          updatedAt: new Date() }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
        hostState = "present";
      } catch { return unavailable(); }
    }
    const realized: RealizedExecutionWorkspace = { cwd: execution.workspace.cwd, baseCwd: execution.workspace.cwd, source: "task_session",
      projectId: workspace?.projectId ?? null, workspaceId: workspace?.projectWorkspaceId ?? null, repoUrl: workspace?.repoUrl ?? null,
      repoRef: workspace?.baseRef ?? null, strategy: workspace?.strategyType === "git_worktree" ? "git_worktree" : "project_primary",
      branchName: workspace?.branchName ?? null, worktreePath: workspace?.strategyType === "git_worktree" ? workspace.providerRef : null,
      warnings: [], additionalWorkspaces: [], created: false, branchCreatedByRuntime: false };
    return { process, execution, workspace, realized, hostState };
  });
}

import { and, eq } from "drizzle-orm";
import { environmentLeases } from "@paperclipai/db";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { instanceSettingsService } from "./instance-settings.js";
import { resolvePaperclipRunnerIdleTimeoutMs } from "@paperclipai/adapter-utils";
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import type { AdapterComputerExecutionTarget, EffectiveExecutionCapabilities } from "@paperclipai/adapter-utils/execution-target";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import { computerService } from "../modules/computers/index.js";
import { environmentService } from "./environments.js";
import type { EnvironmentRuntimeDriver } from "./environment-runtime.js";

export const COMPUTER_CAPABILITIES: EffectiveExecutionCapabilities = {
  reusableLeases: true, nativeSyncIn: false, nativeSyncOut: false,
  persistentProcessSessions: true, independentControlCommands: true,
  incrementalSessionOutput: false, concurrentSyncOperations: false,
  duplexCommandStream: false, runnerWebSocketIngress: true,
};

export function computerOwnerFromLease(lease: EnvironmentLease) {
  const value = lease.metadata?.computerOwner as Record<string, unknown> | undefined;
  if (!value || typeof value.computerId !== "string" || typeof value.ownerId !== "string" ||
      !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 ||
      lease.providerLeaseId !== value.ownerId) throw new Error("computer_owner_binding_invalid");
  return { computerId: value.computerId, ownerId: value.ownerId, generation: Number(value.generation) };
}

export function createComputerEnvironmentDriver(db: Db): EnvironmentRuntimeDriver {
  const computers = computerService(db);
  const leases = environmentService(db);
  const scope = (lease: EnvironmentLease) => {
    if (!lease.environmentId) throw new Error("computer_environment_missing");
    return { companyId: lease.companyId, environmentId: lease.environmentId };
  };
  const recover = (lease: EnvironmentLease) => computers.recover({ ...scope(lease), owner: computerOwnerFromLease(lease) });
  const retire = async (lease: EnvironmentLease, status: "released" | "expired" | "failed") => {
    const result = await computers.retire({ ...scope(lease), owner: computerOwnerFromLease(lease) });
    if (!result.retired) throw new Error("computer_owner_retirement_superseded");
    return leases.releaseLease(lease.id, status, { cleanupStatus: "success",
      remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }) });
  };
  return {
    driver: "computer",
    async acquireRunLease(input) {
      if (!(await instanceSettingsService(db).getExperimental()).enableBoatEnvironments) throw new Error("boat_environments_disabled");
      if (!input.agentId) throw new Error("computer_agent_required");
      const idleTimeoutMs = resolvePaperclipRunnerIdleTimeoutMs(input.environment.config.runnerIdleTimeoutMs);
      const binding = input.heartbeatRunId ? await computers.admit({ companyId: input.companyId, environmentId: input.environment.id,
        agentId: input.agentId, runId: input.heartbeatRunId, idleTimeoutMs,
        sessionKey: createHash("sha256").update(JSON.stringify([input.agentId, input.executionWorkspaceId ?? input.issueId, input.adapterType, input.executionConfigurationKey])).digest("hex") })
        : await computers.admitProbe({ companyId: input.companyId, environmentId: input.environment.id,
          agentId: input.agentId, probeId: randomUUID(), idleTimeoutMs });
      try {
        // The durable owner advanced generation; prior retained bookkeeping no
        // longer owns the process and must not be reaped as an allocation.
        await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success", updatedAt: new Date() })
          .where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.environmentId, input.environment.id),
            eq(environmentLeases.providerLeaseId, binding.owner.ownerId), eq(environmentLeases.status, "retained")));
        return await leases.acquireLease({ companyId: input.companyId, environmentId: input.environment.id,
          executionWorkspaceId: input.executionWorkspaceId, issueId: input.issueId, heartbeatRunId: input.heartbeatRunId,
          leasePolicy: "reuse_by_environment", provider: "boat", providerLeaseId: binding.owner.ownerId,
          metadata: { driver: "computer", agentId: input.agentId, executionWorkspaceMode: input.executionWorkspaceMode,
            computerOwner: binding.owner, listenerPort: binding.listenerPort, remoteCwd: binding.remoteCwd,
            fileAuthority: { kind: "remote-persistent", placementId: binding.placementId, root: binding.remoteCwd, agentHome: binding.agentHome } } });
      } catch (error) {
        await computers.retire({ companyId: input.companyId, environmentId: input.environment.id, owner: binding.owner });
        throw error;
      }
    },
    releaseRunLease: ({ lease, status }) => retire(lease, status),
    destroyRunLease: ({ lease }) => retire(lease, "released"),
    async resumeRunLease({ lease }) { await recover(lease); return lease; },
    async retryPendingSandboxTeardown({ lease }) {
      const result = await computers.retire({ ...scope(lease), owner: computerOwnerFromLease(lease) });
      if (!result.retired) throw new Error("computer_owner_retirement_superseded");
      return { providerLeaseId: lease.providerLeaseId, state: "stopped" };
    },
    async realizeWorkspace({ lease, workspace, gitAuth }) {
      const request = workspace.metadata?.workspaceRealizationRequest as { source?: { projectId?: string; repoUrl?: string; repoRef?: string; branchName?: string; strategy?: string }; issueId?: string } | undefined;
      const result = await computers.realizeWorkspace({ ...scope(lease), owner: computerOwnerFromLease(lease),
        projectId: request?.source?.projectId ?? undefined, taskId: request?.issueId ?? undefined,
        repositoryUrl: request?.source?.repoUrl ?? undefined,
        gitAuth,
        branch: request?.source?.branchName ?? request?.source?.repoRef ?? undefined,
        baseRef: request?.source?.repoRef ?? undefined,
        mode: request?.source?.strategy === "git_worktree" ? "worktree" : "shared" });
      await leases.updateLeaseMetadata(lease.id, { ...lease.metadata, remoteCwd: result.remoteCwd,
        fileAuthority: { kind: "remote-persistent", placementId: result.placementId, root: result.remoteCwd, agentHome: result.agentHome } });
      return { cwd: result.remoteCwd, metadata: { workspaceRealization: { mode: "in_place", authoritativeRoot: result.remoteCwd,
        pathAliases: [], outboundRestorePaths: [] } } };
    },
    async execute({ lease, command, args, cwd, env, stdin, timeoutMs, onLog }) {
      const binding = await recover(lease);
      return binding.runner.execute({ command, args, cwd: cwd ?? binding.remoteCwd, env, stdin, timeoutMs,
        onLog: onLog ? async (stream, chunk) => { await onLog(stream, chunk); } : undefined });
    },
    async resolveCapabilities() { return COMPUTER_CAPABILITIES; },
  };
}

export async function computerExecutionTarget(db: Db, lease: EnvironmentLease, idleTimeoutMs = resolvePaperclipRunnerIdleTimeoutMs(undefined)): Promise<AdapterComputerExecutionTarget> {
  if (!lease.environmentId) throw new Error("computer_environment_missing");
  const computers = computerService(db);
  const scope = { companyId: lease.companyId, environmentId: lease.environmentId };
  const owner = computerOwnerFromLease(lease);
  const binding = await computers.recover({ ...scope, owner });
  const ingress = async (path: string): Promise<RunnerIngressEndpoint> => {
    const endpoint = await binding.process.ingress({ path });
    return { kind: "authenticated_websocket", websocketUrl: endpoint.url,
      secretHeaders: Object.entries(endpoint.secretHeaders).map(([name, value]) => ({ name, value })),
      generation: `${owner.ownerId}:${owner.generation}`, refresh: () => ingress(path), close: async () => {} };
  };
  return { kind: "remote", transport: "computer", providerKey: "boat", environmentId: lease.environmentId, leaseId: lease.id,
    remoteCwd: binding.remoteCwd, listenerPort: binding.listenerPort, runner: binding.runner, processRunner: binding.process.runner, shellCommand: "bash",
    effectiveCapabilities: COMPUTER_CAPABILITIES, reusableLeaseConfigured: true,
    runnerLifecyclePolicy: { mode: "warm", idleTimeoutMs },
    resourceAuthority: { kind: "computer-owner", ...owner },
    fileAuthority: { kind: "remote-persistent", placementId: binding.placementId, root: binding.remoteCwd, agentHome: binding.agentHome },
    workspaceRealization: { mode: "in_place", authoritativeRoot: binding.remoteCwd, pathAliases: [], outboundRestorePaths: [] },
    launch: binding.launch, inspectProcess: binding.inspectProcess,
    retainWarm: (idleTimeoutMs) => computers.retainWarm({ ...scope, owner, idleTimeoutMs }),
    retire: async () => {
      const result = await computers.retire({ ...scope, owner });
      if (result.retired) await environmentService(db).releaseLease(lease.id, "released", { cleanupStatus: "success",
        remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }) });
      return result.retired;
    },
    getRunnerIngressEndpoint: ({ port, path }) => {
      if (port !== binding.listenerPort) throw new Error("computer_runner_port_mismatch");
      return ingress(path);
    },
    computerTool: binding.computerTool,
  };
}

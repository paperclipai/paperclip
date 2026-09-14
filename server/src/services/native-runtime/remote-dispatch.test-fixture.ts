import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agents, completionContracts, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, plugins, projects, type Db } from "@paperclipai/db";
import { captureDirectorySnapshot, directorySnapshotSha256, serializeDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { nativeWorkspaceSyncInternals } from "./native-workspace-sync.js";
import { captureNativeHostWorkspaceReceipt } from "./native-host-workspace-receipt.js";
import { remoteRunnerRecoveryProcess } from "./remote-runner-recovery.js";
import type { NativeRestartRecoveryClaim } from "./native-restart-recovery.js";

export async function seedRemoteDispatchFixture(db: Db, input: { companyId: string; agentId: string; issueId: string; runId: string; hostCwd: string; remoteCwd?: string; durableSeed?: boolean }) {
  const { companyId, agentId, issueId, runId, hostCwd } = input;
  const remoteCwd = input.remoteCwd ?? "/workspace/app";
  await mkdir(hostCwd, { recursive: true }); await writeFile(path.join(hostCwd, "App.jsx"), "export default () => 'original app';\n");
  const [project] = await db.insert(projects).values({ companyId, name: "Remote recovery project" }).returning();
  const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id, sourceIssueId: issueId,
    name: "Original workspace", mode: "isolated_workspace", strategyType: "project_primary", cwd: hostCwd,
    metadata: { config: { provisionCommand: "exit 91", runtimeProvisionCommand: "exit 92" } } }).returning();
  const pluginId = randomUUID();
  await db.insert(plugins).values({ id: pluginId, pluginKey: `fixture.remote.${pluginId}`, packageName: "fixture-remote", version: "1.0.0", status: "ready", apiVersion: 1,
    manifestJson: { id: `fixture.remote.${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "Recovery", description: "Recovery fixture", author: "Paperclip", categories: ["automation"],
      capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" }, environmentDrivers: [{ driverKey: "daytona", kind: "sandbox_provider", displayName: "Daytona", configSchema: { type: "object" } }] } });
  const [environment] = await db.insert(environments).values({ name: `Original ${runId}`, driver: "sandbox", config: { provider: "daytona", image: "node:24", runnerLifecycleMode: "per_turn" } }).returning();
  const leaseId = randomUUID(), providerLeaseId = randomUUID();
  const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
  const native = await prepareNativeHeartbeatRun({ db, run: before!, issue: issue!, environmentLeaseId: leaseId });
  const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
  const execution = buildNativeExecutionInput({ companyId, runId, agentId,
    issue: { id: issueId, identifier: issue!.identifier, title: issue!.title, description: issue!.description, workMode: "standard" },
    taskPrompt: "Continue editing this same dev server", workspace: { id: workspace!.id, cwd: hostCwd, repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId: native.normalizedSessionId, provider: "codex", runtimeContext: nativeRuntimeContextFixture(),
    completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: contract!.schemaVersion,
      contract: contract!.contractJson as unknown as Parameters<typeof buildNativeExecutionInput>[0]["completionContract"]["contract"] } });
  const baseline = await captureDirectorySnapshot(hostCwd, { exclude: [".paperclip-runtime"] });
  let seed: { workspaceArchiveSha256: string; gitArchiveSha256: null } | null = null;
  if (input.durableSeed) {
    const { workspaceArchivePath } = nativeWorkspaceSyncInternals.durableSeedPaths(runId);
    await mkdir(path.dirname(workspaceArchivePath), { recursive: true, mode: 0o700 });
    await promisify(execFile)("tar", ["-cf", workspaceArchivePath, "-C", hostCwd, "."]);
    seed = { workspaceArchiveSha256: createHash("sha256").update(await readFile(workspaceArchivePath)).digest("hex"), gitArchiveSha256: null };
  }
  const reference = await nativeWorkspaceSyncInternals.writeDescriptor({ schema: "paperclip.native-workspace-sync/v1", binding: {
    companyId, runId, workspaceId: workspace!.id, leaseId, providerLeaseId, localCwd: hostCwd, remoteCwd }, state: "prepared",
    baselineSha256: directorySnapshotSha256(baseline), baseline: serializeDirectorySnapshot(baseline), gitSnapshot: null,
    hostWorkspace: await captureNativeHostWorkspaceReceipt(hostCwd), seed,
    createdAt: new Date().toISOString(), finalizedAt: null, finalHostSha256: null, resourceDisposition: "stop_and_retain" });
  const [preparedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  const [run] = await db.update(heartbeatRuns).set({ status: "running", processLocation: "remote", processPid: 40, processGroupId: null, processStartedAt: new Date(),
    runnerProfileJson: { ...preparedRun!.runnerProfileJson, nativeExecutionInput: execution, nativeWorkspaceSync: reference,
      sessionCheckpoint: { schema: "paperclip.native-session-checkpoint/v1", identity: { companyId, agentId, issueId, runId, sessionId: native.normalizedSessionId }, providerSessionId: "original-provider-session" } },
  }).where(eq(heartbeatRuns.id, runId)).returning();
  const owner = { version: 1, pid: 40, processGroupId: 40, uid: 1000, bootId: randomUUID(), startTicks: "100" };
  const connection = { scopeId: runId, fingerprint: "a".repeat(64) };
  const [lease] = await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId: environment!.id, heartbeatRunId: runId,
    issueId, executionWorkspaceId: workspace!.id, provider: "daytona", providerLeaseId, status: "active", metadata: {
      driver: "sandbox", provider: "daytona", sandboxProviderPlugin: true, pluginId, remoteCwd,
      workspaceRealization: { mode: "copy", authoritativeRoot: remoteCwd },
      runtimeServiceBoundary: { version: 1, provider: "daytona", workspaceRoot: remoteCwd },
      runtimeServiceProcessOwner: { version: 1, provider: "daytona", environmentLeaseId: leaseId, providerLeaseId, runId, workspaceRoot: remoteCwd, process: owner },
      runtimeServiceRunScope: { version: 1, companyId, environmentId: environment!.id, executionWorkspaceId: workspace!.id, pluginId, configurationDigest: "b".repeat(64), connection },
    } }).returning();
  const claim: NativeRestartRecoveryClaim = { kind: "reattach_existing_runner", runId, leaseOwner: "dead-controller", controllerGeneration: 1,
    providerAttempt: 0, restartKind: "hard", recoveryRequestId: null, process: remoteRunnerRecoveryProcess(lease!, run!)! };
  await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", leaseOwner: claim.leaseOwner,
    controllerGeneration: 1, controllerBootId: "previous-boot", controllerPid: 2_000_000_001,
    controllerProcessStartedAt: new Date(0), leaseExpiresAt: new Date(Date.now() + 60_000) });
  await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" } }).where(eq(agents.id, agentId));
  await db.update(issues).set({ executionWorkspaceId: workspace!.id, executionWorkspacePreference: "reuse_existing", executionWorkspaceSettings: { mode: "isolated_workspace" } }).where(eq(issues.id, issueId));
  return { ...input, run: run!, claim, lease: lease!, environment: environment!, workspace: workspace!, native, execution, reference, pluginId };
}

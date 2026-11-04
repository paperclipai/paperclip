import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, environmentLeases, environments, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { beforeAll, expect, it, vi } from "vitest";
import { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";
import * as storageBackend from "../storage/index.js";
import { getStorageService } from "../storage/index.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { pinFailedObservedWorkspace } from "../services/native-runtime/native-observed-workspace-preservation.js";
import { heartbeatService } from "../services/heartbeat.js";
import { environmentRuntimeService, classifyEnvironmentCapabilities, type EnvironmentDriverResumeInput } from "../services/environment-runtime.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { registerNativeRunnerCheckpoint } from "../services/native-runtime/native-runner-checkpoint.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "./helpers/native-restart.js";

describeEmbeddedPostgres("heartbeat native remote preparation failure retention", () => {
  const fixture = nativeRestartFixture();
  let runtimeRoot: string, companyId: string, agentId: string;
  beforeAll(() => { ({ runtimeRoot, companyId, agentId } = fixture.current); });

  it.each(["modern", "legacy", "provider_history"] as const)("preserves the allocated workspace when restart preparation fails (%s)", async mode => {
    const f = await fixture.seedRun(`PREPARATION-FAILURE-${mode}`);
    const db = f.db, workspaceId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID();
    const settings = instanceSettingsService(db), previous = await settings.getExperimental();
    const priorDatabase = process.env.DATABASE_URL, priorKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    const localStorage = getStorageService();
    let storage: { mockRestore(): void } | undefined;
    let heartbeat: ReturnType<typeof heartbeatService> | undefined;
    try {
    storage = vi.spyOn(storageBackend, "getStorageService").mockReturnValue({ ...localStorage, provider: "s3" });
    process.env.DATABASE_URL = fixture.current.temporary.connectionString;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "71".repeat(32);
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Original operator", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    const remoteCwd = path.join(runtimeRoot, workspaceId), providerLeaseId = `sandbox://fake/${randomUUID()}`;
    await mkdir(remoteCwd, { recursive: true });
    await writeFile(path.join(remoteCwd, "saved.txt"), "unfinished original work\n");
    await db.insert(environments).values({ id: environmentId, name: `Bound original allocation ${mode}`, driver: "sandbox",
      config: { provider: "fake", image: "fixture:test" } });
    await db.update(agents).set({ defaultEnvironmentId: environmentId }).where(eq(agents.id, agentId));
    const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId,
      remoteCwd, epoch: 1, state: "prepared", snapshotId: null };
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: f.issueId,
      mode: "isolated_workspace", strategyType: "project_primary", providerType: "cloud_sandbox", name: "Original files",
      cwd: `/workspaces/${workspaceId}`, metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1",
        epoch: 1, snapshotId: null, source: { kind: "empty" }, location: { environmentId, leaseId, providerLeaseId, remoteCwd },
        writerRunId: f.runId, dirty: true } } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, f.issueId));
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      executionWorkspaceId: workspaceId, environmentId, provider: "fake", providerLeaseId, status: "active",
      leasePolicy: "ephemeral", metadata: { driver: "sandbox", provider: "fake", image: "fixture:test", remoteCwd, agentId } });
    const execution = buildNativeExecutionInput({ companyId, agentId, runId: f.runId,
      issue: { id: f.issueId, identifier: "NRR-MODERN-PREPARATION-FAILURE", title: "Preserve original work", description: null, workMode: "standard" },
      taskPrompt: "Continue the original task.", provider: "codex",
      workspace: { id: workspaceId, cwd: remoteCwd, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: f.native.normalizedSessionId, runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Preserve original work", criteria: [{ id: "objective", requirement: "Retain files" }] } } });
    const identity = { companyId, issueId: f.issueId, runId: f.runId, agentId, sessionId: f.native.normalizedSessionId };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.preparedProfile, remoteWorkspace: reference,
      nativeExecutionInput: execution, sessionCheckpoint: { identity, providerSessionId: "original-provider" },
      ...(mode === "legacy" ? { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
        descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
        workspaceId, leaseId, providerLeaseId, remoteCwd, resourceDisposition: "stop_and_retain" } } : {}) },
      responsibleUserId: userId, contextSnapshot: { issueId: f.issueId, executionWorkspaceId: workspaceId } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ controllerBootId: fixture.current.successor.bootId,
      controllerGeneration: 1, attempt: 1, leaseOwner: "previous-controller", leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const authority = new DurablePrpControlPlane({ stateDirectory: path.join(runtimeRoot, f.runId, "control-plane"),
      identity: fixture.transportOptions(f, runtimeRoot).prpIdentity,
      expectedRunnerVersion: "retention-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    await registerNativeRunnerCheckpoint({ db, binding: { companyId, issueId: f.issueId, runId: f.runId },
      bootId: fixture.current.successor.bootId, authority });
    await authority.stop();
    if (mode === "provider_history") {
      const event = { schema: "paperclip.prp.event.v1", sourceInstanceId: f.native.runnerInstanceId,
        sourceEventId: randomUUID(), sourceSeq: 1, schemaVersion: 1, sourceKind: "runner", runId: f.runId,
        normalizedSessionId: f.native.normalizedSessionId, turnId: f.native.turnId, eventType: "tool.execution.started",
        priority: 0, emittedAt: new Date().toISOString(), payload: { toolName: "fixture.external_effect", toolCallId: randomUUID() } };
      await appendHeartbeatRunEvent(db, { companyId, agentId, runId: f.runId, eventType: event.eventType,
        stream: "system", level: "info", message: "Original external action has an unknown outcome", payload: { prpEvent: event },
        nativeSource: { sourceEventId: event.sourceEventId, sourceInstanceId: event.sourceInstanceId,
          sourceSeq: event.sourceSeq, protocolSchemaVersion: 1, canonicalPayload: event } });
    }
    await issueRecoveryActionService(db).upsertSourceScoped({ companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: agentId, cause: "native_session_interrupted",
      fingerprint: `native-interruption:${f.runId}`, evidence: { runId: f.runId },
      nextAction: "Inspect the interrupted source and preserve its work.", maxAttempts: 3, wakePolicy: null,
      supersedeOnIdentityChange: true });
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const preparationFailure = new Error("Sandbox failed to become ready within the timeout period");
    const resumed = vi.fn(async () => {
      const [claimedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [claimedOwner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      const [claimedTask] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(claimedRun.status).toBe("running");
      expect(claimedTask.executionRunId).toBe(f.runId);
      expect(claimedOwner.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(claimedOwner.controllerGeneration).toBe(2);
      expect(await pinFailedObservedWorkspace(db, companyId, f.runId)).toBe(false);
      throw preparationFailure;
    });
    const acquireAllocation = vi.fn(async () => { throw new Error("Unexpected new allocation"); });
    const readyAllocation = vi.fn(async ({ lease }: EnvironmentDriverResumeInput) => lease);
    const runtime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox",
      acquireRunLease: acquireAllocation,
      resumeRunLease: readyAllocation,
      releaseRunLease: async () => { throw new Error("Unexpected destructive cleanup"); },
      retryPendingSandboxTeardown: async () => { throw new Error("Stop must remain separately verified"); },
      realizeWorkspace: async () => { throw new Error("Unexpected workspace realization"); },
      execute: resumed,
      syncIn: resumed,
      syncOut: resumed,
      supportsSync: () => true,
      resolveCapabilities: async () => classifyEnvironmentCapabilities({ verifiedMethods: ["environmentSyncIn", "environmentSyncOut", "environmentExecute"], declared: null, narrowing: null }),
    }] });
    await settings.updateExperimental({ enableNativeRunner: true });
    heartbeat = heartbeatService(db, { environmentRuntime: runtime,
      nativeSessionBackendFactory: () => { throw new Error("No provider backend may be created"); } });
      await heartbeat.recoverNativeRunsAfterRestart(new Date(), [f.runId]);
      await heartbeat.drainActiveRunExecutions();
      expect(readyAllocation).toHaveBeenCalledExactlyOnceWith({
        environment: expect.objectContaining({ id: environmentId }),
        lease: expect.objectContaining({ id: leaseId, companyId, environmentId,
          executionWorkspaceId: workspaceId, heartbeatRunId: f.runId, providerLeaseId,
          status: "active", leasePolicy: "ephemeral" }),
        requestedCwd: remoteCwd,
      });
      expect(acquireAllocation).not.toHaveBeenCalled();
      expect(resumed).toHaveBeenCalledOnce();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run.error).toBe(preparationFailure.message);
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
      expect({ status: run.status, phase: coordinator.phase, taskExecution: task.executionRunId, dirty: workspace.metadata?.remoteWorkspace })
        .toMatchObject({ status: "failed", phase: "terminal_failure", taskExecution: null, dirty: { writerRunId: f.runId, dirty: true } });
      expect(run.resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { leaseIds: [leaseId] } });
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      expect(lease).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure",
        metadata: { sandboxStopAndRetain: { runId: f.runId, leaseId } } });
      expect(await readFile(path.join(remoteCwd, "saved.txt"), "utf8")).toBe("unfinished original work\n");
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))
        .toEqual(expect.arrayContaining([expect.objectContaining({ evidence: expect.objectContaining({ workspaceRestoreRecovery: expect.any(Object) }) })]));
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
      if (mode === "provider_history") expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId)))
        .toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "tool.execution.started", sourceSeq: 1 })]));
    } finally {
      try { await heartbeat?.drainActiveRunExecutions(); }
      finally {
        storage?.mockRestore();
        if (priorDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabase;
        if (priorKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY; else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorKey;
        await settings.updateExperimental(previous);
      }
    }
  }, 60_000);
});

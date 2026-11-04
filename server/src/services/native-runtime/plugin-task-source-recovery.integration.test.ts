import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, environmentLeases, environments, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunResults, nativeRunnerCheckpoints, plugins } from "@paperclipai/db";
import { DurablePrpControlPlane, type DurablePrpCheckpoint } from "../../vendor/paperclip-runner/index.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { executeEnvironmentTask, resolvePluginTaskResume } from "../environment-task-runtime.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { NativeExecutionContext } from "./native-execution-context.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { loadNativeRunnerCheckpoint, nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { claimPluginTaskSourceRecovery } from "./plugin-task-source-recovery.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

describe.skipIf(!recoveryPostgresSupport.supported)("stopped source admission under the current native owner", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: ReturnType<typeof createDb>;
  let home: ReturnType<typeof createIsolatedTestHome>, root: string;
  const originalHome = process.env.PAPERCLIP_HOME;
  const contexts: NativeExecutionContext[] = [];
  beforeAll(async () => {
    home = createIsolatedTestHome(); process.env.PAPERCLIP_HOME = home.home;
    root = await mkdtemp(join(tmpdir(), "plugin-source-recovery-"));
    database = await startRecoveryPostgres("plugin-source-recovery-"); db = createDb(database.connectionString);
  }, 60_000);
  afterEach(() => { for (const context of contexts.splice(0)) context.finish(); });
  afterAll(async () => {
    await database?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); home?.cleanup();
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = originalHome;
  });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID(), runId = randomUUID();
    const sourceLeaseId = randomUUID(), leaseId = randomUUID(), environmentId = randomUUID(), pluginId = randomUUID();
    const controller = await currentNativeControllerIdentity(), oldOwner = { bootId: controller.bootId, generation: 1, leaseOwner: randomUUID() };
    await db.insert(companies).values({ id: companyId, name: "Source admission", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Source worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue once", status: "in_progress", assigneeAgentId: agentId });
    const [sourceRun] = await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId,
      status: "running", runtimeMode: "native" }).returning();
    const native = await prepareNativeHeartbeatRun({ db, run: sourceRun, issue: { id: issueId, title: "Continue once", description: null }, environmentLeaseId: sourceLeaseId });
    const [prepared] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId));
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.id, prepared.completionContractId!));
    const build = (id: string) => buildNativeExecutionInput({ companyId, agentId, runId: id, normalizedSessionId: native.normalizedSessionId,
      provider: "codex", issue: { id: issueId, identifier: "SOURCE-1", title: "Continue once", description: null, workMode: "standard" },
      taskPrompt: "Continue once", workspace: { id, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: prepared.completionContractId!, sha256: prepared.completionContractSha256!, schemaVersion: "paperclip.run-result.v1", contract: contract.contractJson as never },
      runtimeContext: nativeRuntimeContextFixture() });
    const sourceExecution = build(sourceRunId), execution = build(runId);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...prepared.runnerProfileJson, nativeExecutionInput: sourceExecution } }).where(eq(heartbeatRuns.id, sourceRunId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: sourceRunId, phase: "observed", controllerBootId: oldOwner.bootId,
      controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: oldOwner.generation,
      leaseOwner: oldOwner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) });
    const identity = { runnerInstanceId: native.runnerInstanceId, environmentLeaseId: sourceLeaseId, runId: sourceRunId,
      normalizedSessionId: native.normalizedSessionId, turnId: native.turnId, itemId: native.itemId };
    const oldWriter = nativeRunnerCheckpointWriter(db, { companyId, issueId, runId: sourceRunId, authorityRunId: sourceRunId, ...oldOwner });
    let checkpoint!: DurablePrpCheckpoint;
    const core = new DurablePrpControlPlane({ stateDirectory: join(root, sourceRunId), identity,
      expectedRunnerVersion: "source-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    core.setCheckpointPersistence(async value => { checkpoint = value; await oldWriter(value); });
    await core.flushCheckpoint(); await core.stop();
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId: sourceRunId,
      completionContractId: prepared.completionContractId!, serverFingerprint: "accepted-source", schemaStatus: "accepted",
      resultJson: { summary: "Accepted once" }, canonicalSha256: "accepted-source" }).returning();
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, sourceRunId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(Date.now() - 1_000), resultJson: { summary: "Accepted once" } }).where(eq(heartbeatRuns.id, sourceRunId));
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native",
      nativeSessionId: native.normalizedSessionId, runnerProfileJson: { nativeExecutionInput: execution } });
    const owner = { bootId: controller.bootId, generation: 3, leaseOwner: randomUUID() };
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", controllerBootId: owner.bootId,
      controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: owner.generation,
      leaseOwner: owner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "source-fixture", version: "1.0.0", status: "ready",
      manifestJson: { capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true }] } as never });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "plugin", status: "active",
      config: { pluginKey: pluginId, driverKey: "tasks" } });
    const metadata = { driver: "plugin", pluginId, driverKey: "tasks", runnerTaskLease: true };
    const sourceLease = { id: sourceLeaseId, companyId, heartbeatRunId: sourceRunId, provider: `plugin:${pluginId}:tasks`, providerLeaseId: "source-task" };
    await db.insert(environmentLeases).values({ ...sourceLease, environmentId, issueId, leasePolicy: "reuse_by_environment", status: "released",
      releasedAt: new Date(), cleanupStatus: "success", metadata: { ...metadata, runnerTaskIdentity: { runnerId: identity.runnerInstanceId,
        leaseId: identity.environmentLeaseId, runId: sourceRunId, sessionId: identity.normalizedSessionId, turnId: identity.turnId, itemId: identity.itemId },
        remoteExecutionTermination: remoteTerminationReceipt(sourceLease, { providerLeaseId: "source-task", state: "stopped" }) } });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, issueId, heartbeatRunId: runId,
      provider: sourceLease.provider, providerLeaseId: "replacement-task", leasePolicy: "reuse_by_environment", status: "active", metadata });
    const context = new NativeExecutionContext(execution, 60_000); context.bindNativeLease(owner); contexts.push(context);
    const input = { companyId, leaseId, context, identity, resumeFrom: "source-task", sourceRecoveryVersion: 1 as const,
      accountIdentity: "current-selected-account", matchesExecution: (previous: typeof sourceExecution) => previous.provider.kind === execution.provider.kind && previous.workspace.cwd === execution.workspace.cwd };
    const workers = { getWorker: () => ({ supportedMethods: ["environmentTask"] }), call: vi.fn(async (_id: string, _method: string, p: any) => {
      if (p.operation.kind === "prepare") return { kind: "prepared", taskId: p.taskId,
        launch: { configurationId: "source-configuration", requirementsDigest: `sha256:${"a".repeat(64)}`, provider: {} } };
      if (p.operation.kind === "check_project_auth") return { kind: "project_auth", taskId: p.taskId, provider: "openai", configurationId: p.operation.configurationId, allowed: true };
      return { kind: "accepted", taskId: p.taskId };
    }) };
    const operation = { kind: "prepare" as const, resumeFrom: input.resumeFrom, recoveryPurpose: "source_reconcile" as const,
      accountIdentity: input.accountIdentity, projectIds: [], requirements: { schema: "paperclip.runner.launch-requirements.v1" as const,
        identity, provider: "codex" as const, model: null, instructions: "Source policy", runtimeContext: null, settings: {}, approvalPolicy: "never" as const,
        readOnly: false, preparedConversation: false, includeCollaborationModeInstructions: false } };
    const task = (op: Parameters<typeof executeEnvironmentTask>[2]["operation"] = operation) => executeEnvironmentTask(db, workers as unknown as PluginWorkerManager,
      { companyId, leaseId, executionContext: context, operation: op });
    return { ...input, runId, sourceRunId, sourceLeaseId, environmentId, agentId, issueId, owner, oldOwner, oldWriter, checkpoint, execution, operation, workers, task };
  }

  it("authorizes only the explicit source request while preserving A's accepted outcome", async () => {
    const f = await fixture();
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await expect(f.task()).rejects.toThrow("ownership_unverified");
    await claimPluginTaskSourceRecovery(db, f);
    await expect(f.task()).resolves.toMatchObject({ kind: "prepared" });
    expect(f.workers.call.mock.calls[0][2]).toMatchObject({ runId: f.runId, operation: { recoveryPurpose: "source_reconcile", requirements: { identity: f.identity } } });
    await f.task({ kind: "check_project_auth", configurationId: "source-configuration", provider: "openai", projectIds: [] });
    await expect(f.task({ kind: "submit", recoveryPurpose: "source_reconcile", resumeFrom: f.resumeFrom,
      accountIdentity: f.accountIdentity, preparedLaunchId: "source-configuration", projectIds: [], bootstrapTicket: "synthetic-test-ticket",
      runner: { runnerId: f.identity.runnerInstanceId, leaseId: f.identity.environmentLeaseId, runId: f.sourceRunId,
        sessionId: f.identity.normalizedSessionId, turnId: f.identity.turnId, itemId: f.identity.itemId, harness: "codex", protocolMin: 1, protocolMax: 1 },
      launch: { runnerVersion: "source-fixture", runnerDigest: `sha256:${"a".repeat(64)}`,
        maxOutboxBytes: 262144, p0ReserveBytes: 65536, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } },
    })).resolves.toMatchObject({ kind: "accepted" });
    expect(f.workers.call.mock.calls.at(-1)![2]).toMatchObject({ runId: f.runId, operation: {
      kind: "submit", recoveryPurpose: "source_reconcile", runner: { runId: f.sourceRunId },
    } });
    await expect(f.task({ ...f.operation, recoveryPurpose: undefined } as never)).rejects.toThrow("execution identity mismatch");
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(after).toEqual(before);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(JSON.stringify(lease.metadata)).not.toContain(f.owner.leaseOwner);
  });

  it.each(["runnerInstanceId", "environmentLeaseId", "runId", "normalizedSessionId", "turnId", "itemId"] as const)("rejects a different source %s", async key => {
    const f = await fixture();
    await expect(claimPluginTaskSourceRecovery(db, { ...f, identity: { ...f.identity, [key]: randomUUID() } })).rejects.toThrow();
    expect(f.workers.call).not.toHaveBeenCalled();
  });

  it.each(["before-claim", "after-claim"])("rejects a stale same-boot coordinator context: %s", async point => {
    const f = await fixture(); if (point === "after-claim") await claimPluginTaskSourceRecovery(db, f);
    await db.update(nativeRunFinalizations).set({ controllerGeneration: f.owner.generation + 1, leaseOwner: randomUUID() }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (point === "before-claim") await expect(claimPluginTaskSourceRecovery(db, f)).rejects.toThrow("context_owner_changed");
    else await expect(f.task()).rejects.toThrow("context_owner_changed");
    expect(f.workers.call).not.toHaveBeenCalled();
  });

  it("rejects a worker reply after the same controller has lost its acquired generation", async () => {
    const f = await fixture(); await claimPluginTaskSourceRecovery(db, f);
    const perform = f.workers.call.getMockImplementation()!;
    f.workers.call.mockImplementation(async (...args) => {
      const result = await perform(...args);
      await db.update(nativeRunFinalizations).set({ controllerGeneration: f.owner.generation + 1, leaseOwner: randomUUID() })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      return result;
    });
    await expect(f.task()).rejects.toThrow("reconcile the same task");
    await expect(f.task()).rejects.toThrow("context_owner_changed");
    expect(f.workers.call).toHaveBeenCalledTimes(1);
  });

  it.each(["capability", "expired", "paused", "source-live", "driver", "header", "source-profile", "current-profile", "workspace-export", "legacy-settlement"])("holds an ineligible recovery: %s", async mode => {
    const f = await fixture();
    if (mode === "expired") await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (mode === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    if (mode === "source-live") await db.update(environmentLeases).set({ cleanupStatus: null }).where(eq(environmentLeases.id, f.sourceLeaseId));
    if (mode === "driver") await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || '{"driverKey":"other"}'::jsonb` }).where(eq(environmentLeases.id, f.sourceLeaseId));
    if (mode === "header") await db.update(nativeRunnerCheckpoints).set({ material: {} }).where(eq(nativeRunnerCheckpoints.runId, f.sourceRunId));
    if (mode === "source-profile" || mode === "current-profile") await db.update(heartbeatRuns).set({ runnerProfileJson:
      sql`jsonb_set(${heartbeatRuns.runnerProfileJson}, '{nativeExecutionInput,binding,issueId}', ${JSON.stringify(randomUUID())}::jsonb)` })
      .where(eq(heartbeatRuns.id, mode === "source-profile" ? f.sourceRunId : f.runId));
    if (mode === "workspace-export") await db.update(heartbeatRuns).set({ runnerProfileJson: sql`${heartbeatRuns.runnerProfileJson} || ${JSON.stringify({ nativeWorkspaceSync: {
      schema: "paperclip.native-workspace-sync/v3", state: "prepared", leaseId: f.sourceLeaseId, providerLeaseId: f.resumeFrom,
      workspaceId: f.issueId, remoteCwd: "/workspace", resourceDisposition: "keep_running", descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
    } })}::jsonb` }).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (mode === "legacy-settlement") await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ legacyShutdownWorkspaceSettlement: {
      schema: "paperclip.legacy-shutdown-workspace-settlement.v1", state: "pending", runId: f.sourceRunId, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    } })}::jsonb` }).where(eq(environmentLeases.id, f.sourceLeaseId));
    await expect(claimPluginTaskSourceRecovery(db, { ...f, ...(mode === "capability" ? { sourceRecoveryVersion: undefined } : {}) })).rejects.toThrow();
    const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.sourceLeaseId));
    expect(source.metadata?.runnerTaskSourceConsumer).toBeUndefined(); expect(f.workers.call).not.toHaveBeenCalled();
  });

  it("pins the consumer and current account across retries", async () => {
    const f = await fixture(), claim = await claimPluginTaskSourceRecovery(db, f);
    expect(await claimPluginTaskSourceRecovery(db, f)).toEqual(claim);
    await expect(claimPluginTaskSourceRecovery(db, { ...f, accountIdentity: "different-account" })).rejects.toThrow();
    await expect(f.task({ ...f.operation, accountIdentity: "different-account" })).rejects.toThrow();
    const competingLease = randomUUID();
    const [original] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    await db.insert(environmentLeases).values({ ...original, id: competingLease, providerLeaseId: "other-replacement" });
    await expect(claimPluginTaskSourceRecovery(db, { ...f, leaseId: competingLease })).rejects.toThrow();
    await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || '{"runnerTaskSessionRetained":true}'::jsonb` })
      .where(eq(environmentLeases.id, f.sourceLeaseId));
    await expect(resolvePluginTaskResume(db, { ...f, priorIdentity: f.identity })).resolves.toBe(f.resumeFrom);
    await expect(resolvePluginTaskResume(db, { ...f, leaseId: competingLease, priorIdentity: f.identity })).rejects.toThrow("not authorized");
  });

  it("allows the last A write before consumption and rejects stale A writes afterward", async () => {
    const f = await fixture();
    await expect(f.oldWriter(f.checkpoint)).resolves.toBeUndefined();
    await claimPluginTaskSourceRecovery(db, f);
    await expect(f.oldWriter(f.checkpoint)).rejects.toThrow("checkpoint_owner_lost");
    const writer = nativeRunnerCheckpointWriter(db, { companyId: f.companyId, issueId: f.issueId, runId: f.sourceRunId,
      authorityRunId: f.runId, ...f.owner });
    await expect(writer(f.checkpoint)).resolves.toBeUndefined();
    expect((await loadNativeRunnerCheckpoint(db, { companyId: f.companyId, issueId: f.issueId, runId: f.sourceRunId }))?.runId).toBe(f.sourceRunId);
    await expect(writer({ ...f.checkpoint, records: new Map([["header", "{}"]]) })).rejects.toThrow("checkpoint_owner_lost");
    await db.update(environmentLeases).set({ metadata: sql`jsonb_set(${environmentLeases.metadata}, '{runnerTaskSourceRecovery,controllerGeneration}', '99'::jsonb)` }).where(eq(environmentLeases.id, f.leaseId));
    await expect(writer(f.checkpoint)).rejects.toThrow("checkpoint_owner_lost");
  });

  it.each(["writer", "claim"] as const)("serializes a concurrent source writer and claim when %s commits first", async first => {
    const f = await fixture();
    let pending: Promise<{ error?: unknown }> | undefined;
    try {
      await db.transaction(async tx => {
        if (first === "writer") {
          await nativeRunnerCheckpointWriter(tx as unknown as typeof db, { companyId: f.companyId, issueId: f.issueId,
            runId: f.sourceRunId, authorityRunId: f.sourceRunId, ...f.oldOwner })(f.checkpoint);
        } else await claimPluginTaskSourceRecovery(tx as unknown as typeof db, f);
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        pending = (first === "writer" ? claimPluginTaskSourceRecovery(db, f) : f.oldWriter(f.checkpoint))
          .then(() => ({}), error => ({ error }));
        await vi.waitFor(async () => {
          const [waiting] = await db.execute<{ blocked: boolean }>(sql`select exists (
            select 1 from pg_stat_activity where datname = current_database()
              and ${backend.pid} = any(pg_blocking_pids(pid))) as blocked`);
          expect(waiting.blocked).toBe(true);
        });
      });
    } finally {
      const result = await pending;
      if (first === "writer") expect(result).toEqual({});
      else expect(result?.error).toMatchObject({ message: "native_runner_checkpoint_owner_lost" });
    }
    const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.sourceLeaseId));
    expect(source.metadata?.runnerTaskSourceConsumer).toMatchObject({ leaseId: f.leaseId, runId: f.runId });
  });
});

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { environmentTaskOperationSchema, type PluginEnvironmentTaskResult } from "@paperclipai/plugin-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, environmentLeases, environments, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunResults, nativeRunnerCheckpoints, plugins } from "@paperclipai/db";
import { canonicalNativeRuntimeContextDigest, parseNativeExecutionInput, runnerProviderLaunchRequirements, DurablePrpControlPlane, type DurablePrpCheckpoint, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { executeEnvironmentTask, resolvePluginTaskResume } from "../environment-task-runtime.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { assertAttachedPortableTask, readyPortableTaskSource, reconcilePluginTaskOwnership } from "../plugin-task-ownership.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import * as runtimeApi from "../../runtime-api.js";
import { NativeExecutionContext } from "./native-execution-context.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { createRunnerdBackend, nativeControllerMigrationDescriptor } from "./native-session-executor.js";
import { buildNativeExecutionWithCheckpoint, nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
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

  async function fixture(provider: "codex" | "claude" | "acpx_codex" = "codex", currentModel?: string) {
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
    const build = (id: string, selected = provider) => buildNativeExecutionInput({ companyId, agentId, runId: id, normalizedSessionId: native.normalizedSessionId,
      provider: selected === "codex" ? "codex" : "acpx", acpxAgent: selected === "claude" ? "claude" : "codex",
      ...(selected === "codex" ? {} : { model: selected === "claude" ? "claude-sonnet-4-6" : "gpt-6" }), issue: { id: issueId, identifier: "SOURCE-1", title: "Continue once", description: null, workMode: "standard" },
      taskPrompt: "Continue once", workspace: { id, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: prepared.completionContractId!, sha256: prepared.completionContractSha256!, schemaVersion: "paperclip.run-result.v1", contract: contract.contractJson as never },
      runtimeContext: nativeRuntimeContextFixture() });
    const sourceExecution = build(sourceRunId), execution = build(runId);
    if (currentModel !== undefined) execution.provider.model = currentModel;
    await db.update(heartbeatRuns).set({ driverKind: sourceExecution.session.driverKind,
      runnerProfileJson: { ...prepared.runnerProfileJson, provider: sourceExecution.provider.kind, nativeExecutionInput: sourceExecution } }).where(eq(heartbeatRuns.id, sourceRunId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: sourceRunId, phase: "observed", controllerBootId: oldOwner.bootId,
      controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: oldOwner.generation,
      leaseOwner: oldOwner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) });
    const identity = { runnerInstanceId: native.runnerInstanceId, environmentLeaseId: sourceLeaseId, runId: sourceRunId,
      normalizedSessionId: native.normalizedSessionId, turnId: `turn-${sourceRunId}`, itemId: `item-${sourceRunId}` };
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
      manifestJson: { capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true, sessionHandoffVersion: 1 }] } as never });
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
    const input = { companyId, leaseId, context, identity, resumeFrom: "source-task",
      ...(provider === "codex" ? { codexSourceRecoveryVersion: 1 as const } : { acpxSourceRecoveryVersion: 1 as const }),
      accountIdentity: "current-selected-account", matchesExecution: (previous: typeof sourceExecution) => previous.provider.kind === execution.provider.kind && previous.workspace.cwd === execution.workspace.cwd };
    const workers = { getWorker: () => ({ supportedMethods: ["environmentTask"] }), call: vi.fn(async (_id: string, _method: string, p: any): Promise<PluginEnvironmentTaskResult> => {
      if (p.operation.kind === "prepare") return { kind: "prepared", taskId: p.taskId,
        launch: { configurationId: "source-configuration", requirementsDigest: `sha256:${"a".repeat(64)}`, provider: {} } };
      if (p.operation.kind === "check_project_auth") return { kind: "project_auth", taskId: p.taskId, provider: p.operation.provider, configurationId: p.operation.configurationId, allowed: true };
      return { kind: "accepted", taskId: p.taskId };
    }) };
    const operation = environmentTaskOperationSchema.parse({ kind: "prepare" as const, resumeFrom: input.resumeFrom,
      accountIdentity: input.accountIdentity, projectIds: [], requirements: provider === "codex" ? { schema: "paperclip.runner.launch-requirements.v1" as const,
        identity, provider: "codex" as const, model: null, instructions: "Source policy", runtimeContext: null, settings: {}, approvalPolicy: "never" as const,
        readOnly: false, preparedConversation: false, includeCollaborationModeInstructions: false } : runnerProviderLaunchRequirements({
          provider: "acpx", acpxAgent: provider === "claude" ? "claude" : "codex",
        }, identity, { model: sourceExecution.provider.model, config: { include_collaboration_mode_instructions: false } },
          "runtimeContext" in sourceExecution ? sourceExecution.runtimeContext : null, "Source policy") });
    if (operation.kind !== "prepare") throw new Error("invalid source preparation fixture");
    const submit = { kind: "submit" as const, resumeFrom: input.resumeFrom, accountIdentity: input.accountIdentity,
      preparedLaunchId: "source-configuration", projectIds: [], bootstrapTicket: "synthetic-test-ticket",
      runner: { runnerId: identity.runnerInstanceId, leaseId: identity.environmentLeaseId, runId: sourceRunId,
        sessionId: identity.normalizedSessionId, turnId: identity.turnId, itemId: identity.itemId,
        harness: provider === "claude" ? "claude" : "codex", protocolMin: 1, protocolMax: 1 },
      launch: { runnerVersion: "source-fixture", runnerDigest: `sha256:${"a".repeat(64)}`, maxOutboxBytes: 262144,
        p0ReserveBytes: 65536, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } } };
    const task = (op: Parameters<typeof executeEnvironmentTask>[2]["operation"] = operation) => executeEnvironmentTask(db, workers as unknown as PluginWorkerManager,
      { companyId, leaseId, executionContext: context, operation: op });
    return { ...input, runId, sourceRunId, sourceLeaseId, environmentId, agentId, issueId, owner, oldOwner, oldWriter, checkpoint, execution, sourceExecution, build, operation, submit, workers, task,
      harness: provider === "claude" ? "claude" as const : "codex" as const, authProvider: provider === "claude" ? "anthropic" : "openai" };
  }

  it.each([
    { policy: "ordinary", scenario: "ordinary handoff" },
    { policy: "reclaim_if_needed", scenario: "idle source reclaim" },
    { policy: "ordinary", scenario: "fresh conversation after instructions change", freshSession: true },
  ] as const)("reconciles ownership after a lost response: $scenario", async scenario => {
    const { policy } = scenario;
    const f = await fixture();
    await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId: f.issueId }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(environmentLeases).set({ status: "retained", releasedAt: null,
      metadata: sql`(${environmentLeases.metadata} - 'remoteExecutionTermination') || ${JSON.stringify({
        providerMetadata: { ownershipGeneration: "source-generation" }, runnerTaskAccountIdentity: f.accountIdentity,
      })}::jsonb`,
    }).where(eq(environmentLeases.id, f.sourceLeaseId));
    await db.update(environmentLeases).set({
      metadata: sql`${environmentLeases.metadata} || '{"providerMetadata":{"ownershipGeneration":"target-generation"}}'::jsonb`,
    }).where(eq(environmentLeases.id, f.leaseId));
    const request = { companyId: f.companyId, sourceLeaseId: f.sourceLeaseId, targetLeaseId: f.leaseId, policy };
    const send = (database: typeof db) => reconcilePluginTaskOwnership(database, request, operation =>
      executeEnvironmentTask(database, f.workers as unknown as PluginWorkerManager, { companyId: f.companyId, leaseId: f.leaseId, operation }));
    const describe = (database: typeof db, ownershipSignal?: AbortSignal) => executeEnvironmentTask(database, f.workers as unknown as PluginWorkerManager,
      { companyId: f.companyId, leaseId: f.leaseId, ownershipSignal, operation: { kind: "describe" } });
    if (policy === "ordinary") await db.update(environmentLeases).set({
      metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ portableTaskPreviousLeaseId: f.sourceLeaseId })}::jsonb`,
    }).where(eq(environmentLeases.id, f.leaseId));
    f.workers.call.mockRejectedValueOnce(new Error("worker transport lost"));
    await expect(policy === "ordinary" ? describe(db) : send(db)).rejects.toThrow();
    const operation = f.workers.call.mock.calls[0][2].operation;
    expect(operation).toMatchObject({ kind: "ensure_ownership", operationId: f.leaseId, identity: f.identity,
      sourceTaskId: "source-task", sourceGeneration: "source-generation", targetGeneration: "target-generation", policy });
    await expect(f.task({ ...operation, policy: policy === "ordinary" ? "reclaim_if_needed" : "ordinary" })).rejects.toThrow("ownership_unverified");
    await expect(f.task()).rejects.toThrow("session ownership unavailable");
    await expect(executeEnvironmentTask(db, f.workers as unknown as PluginWorkerManager, {
      companyId: f.companyId, leaseId: f.sourceLeaseId, operation: { kind: "resume", identity: f.identity, bootstrapTicket: "fixture-ticket" },
    })).rejects.toThrow("session ownership unavailable");
    expect(f.workers.call).toHaveBeenCalledTimes(1);
    const reply = { kind: "ownership", taskId: "replacement-task", operationId: f.leaseId,
      targetGeneration: "target-generation" } as const;
    f.workers.call.mockResolvedValueOnce({ ...reply, status: "pending" });
    await expect(describe(db)).rejects.toThrow("native_portable_task_ownership_pending");
    const targetWriter = nativeRunnerCheckpointWriter(db, { companyId: f.companyId, issueId: f.issueId,
      runId: f.sourceRunId, authorityRunId: f.runId, ...f.owner });
    await expect(targetWriter(f.checkpoint)).rejects.toThrow("native_runner_checkpoint_owner_lost");
    const restarted = createDb(database.connectionString);
    f.workers.call.mockResolvedValueOnce({ ...reply, status: "ready", targetGeneration: "another-generation" });
    await expect(describe(restarted)).rejects.toThrow("reconcile the same task");
    await expect(f.task()).rejects.toThrow("session ownership unavailable");
    const description = { kind: "description", taskId: "replacement-task",
      runner: { version: "test", digest: `sha256:${"a".repeat(64)}` } } as const;
    f.workers.call.mockRejectedValueOnce(new Error("worker transport lost again"));
    f.workers.call.mockResolvedValueOnce({ ...reply, status: "pending" });
    f.workers.call.mockResolvedValueOnce({ ...reply, status: "ready" });
    f.workers.call.mockResolvedValueOnce(description);
    await expect(describe(restarted, new AbortController().signal)).resolves.toEqual(description);
    expect(f.workers.call.mock.calls.map(([, , call]) => call.operation)).toEqual([...Array(6).fill(operation), { kind: "describe" }]);
    const [target] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(target.metadata?.portableTaskOwnershipReady).toBe(true);
    expect(target.metadata?.runnerTaskAccountIdentity).toBe(f.accountIdentity);
    const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.sourceLeaseId));
    expect(source.metadata?.remoteExecutionTermination).toBeUndefined();
    await expect(f.oldWriter(f.checkpoint)).rejects.toThrow("native_runner_checkpoint_owner_lost");
    await expect(targetWriter(f.checkpoint)).resolves.toBeUndefined();

    async function recoverAttachedRunner(execution: NativeExecutionInput, identity: typeof f.identity) {
      const { root: stateDirectory } = nativeControllerMigrationDescriptor(execution,
        nativeToolContractFingerprintForTarget("remote", execution.provider.kind));
      const durable = new DurablePrpControlPlane({ stateDirectory: join(stateDirectory, "control-plane"),
        identity: identity, expectedRunnerVersion: description.runner.version, expectedRunnerDigest: description.runner.digest });
      durable.persistRunAttachTemplate({ provider: { instructions: "Run using the admitted instructions.",
        runtimeContext: "runtimeContext" in execution ? execution.runtimeContext : null } });
      await durable.flushCheckpoint();
      await durable.stop();
      const recover = () => createRunnerdBackend({ db: restarted, execution,
        runnerInstanceId: identity.runnerInstanceId, runnerIngressAuthorized: true,
        runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: ".", leaseId: f.leaseId,
          sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: "replacement-task" },
          runnerTask: (operation, options) => executeEnvironmentTask(restarted, f.workers as unknown as PluginWorkerManager, {
            companyId: f.companyId, leaseId: f.leaseId, operation: environmentTaskOperationSchema.parse(operation),
            expectedTaskId: options?.expectedTaskId,
          }),
        },
        restartRecovery: { kind: "reattach_remote_runner", remote: { kind: "plugin_task", leaseId: f.leaseId },
          runId: f.runId, leaseOwner: "successor", controllerGeneration: f.owner.generation + 1,
          providerAttempt: 1, restartKind: "hard", recoveryRequestId: null },
      });
      f.workers.call.mockClear();
      f.workers.call
        .mockResolvedValueOnce({ kind: "status", taskId: "replacement-task", phase: "running", executionStopped: false })
        .mockResolvedValueOnce({ kind: "state", taskId: "replacement-task",
          state: { schema: "paperclip.runner.durable.state.v1", ...identity } })
        .mockResolvedValueOnce({ ...description, launchPreparationVersion: 1, projectAuthCheckVersion: 1 });
      const api = vi.spyOn(runtimeApi, "resolveLocalRuntimeApiUrl").mockReturnValue("http://127.0.0.1:3100");
      try { await expect(recover()).resolves.toBeDefined(); }
      finally { api.mockRestore(); }
      expect(f.workers.call.mock.calls.map(([, , call]) => [call.taskId, call.operation.kind])).toEqual([
        ["replacement-task", "status"], ["replacement-task", "read_state"], ["replacement-task", "describe"],
      ]);
      return recover;
    }

    if ("freshSession" in scenario) {
      const previousExecution = f.sourceExecution;
      const nativeToolContractFingerprint = nativeToolContractFingerprintForTarget("remote", f.execution.provider.kind);
      const normalizedSessionId = f.identity.normalizedSessionId;
      const previousRun = {
        id: f.sourceRunId, companyId: f.companyId, agentId: f.execution.binding.agentId, nativeSessionId: normalizedSessionId,
        runnerProfileJson: { nativeToolContractFingerprint, nativeExecutionInput: previousExecution,
          sessionCheckpoint: { backendKind: "runner", driverKind: previousExecution.session.driverKind,
            sessionId: "previous-provider-thread", providerSessionId: "previous-provider-thread",
            identity: { ...previousExecution.binding, sessionId: normalizedSessionId }, pendingRuntimeRequests: [] } },
      };
      const select = (current: NativeExecutionInput) => buildNativeExecutionWithCheckpoint({
        previousRun, normalizedSessionId, executionTargetKind: "remote", toolRefreshOnResume: true,
        buildExecution: ({ normalizedSessionId }) => ({ ...current, session: { ...current.session, normalizedSessionId } } as NativeExecutionInput),
      });
      expect(select(f.execution).checkpoint?.providerSessionId).toBe("previous-provider-thread");
      const changed = structuredClone(f.execution);
      if (!("runtimeContext" in changed)) throw new Error("fixture requires runtime context");
      changed.runtimeContext.instructions.bundle.digest = "1".repeat(64);
      changed.runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(changed.runtimeContext);
      const selected = select(changed);
      expect(selected.checkpoint).toBeNull();
      expect(selected.normalizedSessionId).not.toBe(normalizedSessionId);
      const scope = { attachedRunId: f.runId, accountIdentity: f.accountIdentity, selectedSessionId: selected.normalizedSessionId };
      const sourceFor = (identity: unknown) => readyPortableTaskSource(restarted, f.companyId, f.leaseId, identity, scope);
      await expect(sourceFor(null)).rejects.toThrow("ownership_unverified");
      await db.update(heartbeatRuns).set({ nativeSessionId: selected.normalizedSessionId }).where(eq(heartbeatRuns.id, f.runId));
      await expect(sourceFor(null)).rejects.toThrow("ownership_unverified");
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: selected.execution } })
        .where(eq(heartbeatRuns.id, f.runId));
      await expect(sourceFor(null)).resolves.toBeUndefined();
      await expect(sourceFor(f.identity)).rejects.toThrow("ownership_unverified");
      const duplicate = randomUUID();
      await db.insert(environmentLeases).values({ ...target, id: duplicate, providerLeaseId: "ambiguous-task" });
      await expect(sourceFor(null)).rejects.toThrow("ownership_unverified");
      await db.delete(environmentLeases).where(eq(environmentLeases.id, duplicate));

      const fresh = { ...f.identity, runId: f.runId, environmentLeaseId: f.leaseId, runnerInstanceId: randomUUID(),
        normalizedSessionId: selected.normalizedSessionId, turnId: "fresh-turn", itemId: "fresh-item" };
      const prepare = { ...f.operation, resumeFrom: undefined, requirements: { ...f.operation.requirements, identity: fresh } };
      const submit = { ...f.submit, resumeFrom: undefined, runner: { ...f.submit.runner,
        runnerId: fresh.runnerInstanceId, leaseId: fresh.environmentLeaseId, runId: fresh.runId,
        sessionId: fresh.normalizedSessionId, turnId: fresh.turnId, itemId: fresh.itemId } };
      f.workers.call.mockClear();
      await expect(f.task(prepare)).resolves.toMatchObject({ kind: "prepared" });
      await expect(f.task({ kind: "check_project_auth", provider: "openai", projectIds: [],
        configurationId: submit.preparedLaunchId })).resolves.toMatchObject({ kind: "project_auth", allowed: true });
      await expect(f.task(submit)).resolves.toMatchObject({ kind: "accepted" });
      expect(f.workers.call.mock.calls.map(([, , call]) => call.operation.kind)).toEqual(["prepare", "check_project_auth", "submit"]);
      expect(f.workers.call.mock.calls.every(([, , call]) => call.taskId === "replacement-task" &&
        call.operation.resumeFrom === undefined && call.operation.priorIdentity === undefined)).toBe(true);
      await expect(sourceFor(null)).rejects.toThrow("ownership_unverified");
      await expect(sourceFor({ ...fresh, turnId: "wrong-turn" })).rejects.toThrow("ownership_unverified");
      await expect(sourceFor(fresh)).resolves.toBeUndefined();
      await recoverAttachedRunner(selected.execution, fresh);
      return;
    }

    const resume = { kind: "resume", identity: f.identity, bootstrapTicket: "fixture-ticket" } as const;
    f.workers.call.mockResolvedValueOnce({ kind: "resume", taskId: "replacement-task", outcome: "resumed" });
    await expect(f.task(resume)).resolves.toMatchObject({ kind: "resume", outcome: "resumed" });
    const [dispatched] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(dispatched.metadata?.runnerTaskDispatched).toBe(true);

    const readState = { kind: "read_state", identity: f.identity } as const;
    await expect(f.task({ ...readState, identity: { ...f.identity, itemId: "wrong-item" } }))
      .rejects.toThrow("ownership_unverified");
    f.workers.call.mockResolvedValueOnce({ kind: "state", taskId: "replacement-task", state: { ...f.identity } });
    await expect(f.task(readState)).resolves.toMatchObject({ kind: "state", state: f.identity });
    const nextIdentity = { ...f.identity, runId: f.runId, turnId: "target-turn", itemId: "target-item" };
    const attach = { ...f.operation, resumeFrom: undefined, priorIdentity: f.identity,
      requirements: { ...f.operation.requirements, identity: nextIdentity } };
    await expect(f.task({ ...attach, requirements: { ...attach.requirements,
      identity: { ...nextIdentity, normalizedSessionId: randomUUID() } } })).rejects.toThrow("prior identity mismatch");
    await expect(f.task(attach)).resolves.toMatchObject({ kind: "prepared" });
    await expect(f.task(attach)).resolves.toMatchObject({ kind: "prepared" });
    const [attached] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(attached.metadata?.runnerTaskIdentity).toMatchObject({ runId: f.runId, sessionId: f.identity.normalizedSessionId });
    expect(attached.metadata?.runnerTaskPriorIdentity).toMatchObject({ runId: f.sourceRunId, itemId: f.identity.itemId });
    const scope = { attachedRunId: f.runId, accountIdentity: f.accountIdentity };
    await expect(readyPortableTaskSource(db, f.companyId, f.leaseId, nextIdentity, scope)).resolves.toBeUndefined();
    await expect(readyPortableTaskSource(db, f.companyId, f.leaseId, { ...nextIdentity, turnId: "wrong-turn" }, scope))
      .rejects.toThrow("ownership_unverified");
    await expect(readyPortableTaskSource(db, f.companyId, f.leaseId, f.identity, scope))
      .resolves.toEqual({ taskId: "source-task", identity: f.identity });
    await expect(readyPortableTaskSource(db, f.companyId, f.leaseId, f.identity, { ...scope, accountIdentity: "another-account" }))
      .rejects.toThrow("ownership_unverified");

    const binding = { companyId: f.companyId, leaseId: f.leaseId, taskId: "replacement-task", runId: f.runId, identity: nextIdentity };
    await expect(assertAttachedPortableTask(restarted, binding)).resolves.toBeUndefined();
    for (const invalid of [
      { ...binding, leaseId: f.sourceLeaseId },
      { ...binding, taskId: "source-task" },
      { ...binding, identity: f.identity },
      { ...binding, identity: { ...nextIdentity, environmentLeaseId: f.leaseId } },
    ]) await expect(assertAttachedPortableTask(restarted, invalid)).rejects.toThrow("ownership_unverified");

    if (policy === "ordinary") {
      const recover = await recoverAttachedRunner(f.execution, nextIdentity);
      await db.update(environmentLeases).set({
        metadata: sql`${environmentLeases.metadata} - 'portableTaskSuccessor'`,
      }).where(eq(environmentLeases.id, f.sourceLeaseId));
      f.workers.call.mockClear();
      await expect(recover()).rejects.toThrow("ownership_unverified");
      expect(f.workers.call).not.toHaveBeenCalled();
    }
  });

  it.each(["codex", "claude"] as const)("authorizes the claimed %s source while preserving A's accepted outcome", async provider => {
    const f = await fixture(provider);
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await expect(f.task()).rejects.toThrow("execution identity mismatch");
    await claimPluginTaskSourceRecovery(db, f);
    const attachment = { ...f.operation, resumeFrom: undefined, priorIdentity: f.identity,
      requirements: { ...f.operation.requirements, identity: { ...f.identity, runId: f.runId, turnId: `turn-${f.runId}`, itemId: `item-${f.runId}` } } };
    await expect(f.task(attachment)).rejects.toThrow("ownership_unverified");
    expect(f.workers.call).not.toHaveBeenCalled();
    await expect(f.task()).resolves.toMatchObject({ kind: "prepared" });
    expect(f.workers.call.mock.calls[0][2]).toMatchObject({ runId: f.runId, operation: { requirements: { identity: f.identity } } });
    await f.task({ kind: "check_project_auth", configurationId: "source-configuration", provider: f.authProvider, projectIds: [] });
    await expect(f.task(f.submit)).resolves.toMatchObject({ kind: "accepted" });
    expect(f.workers.call.mock.calls.at(-1)![2]).toMatchObject({ runId: f.runId, operation: {
      kind: "submit", runner: { runId: f.sourceRunId },
    } });
    for (const key of ["runId", "runnerInstanceId", "environmentLeaseId", "normalizedSessionId"]) {
      await expect(f.task({ ...attachment, requirements: { ...attachment.requirements,
        identity: { ...attachment.requirements.identity, [key]: randomUUID() } } })).rejects.toThrow("ownership_unverified");
    }
    await expect(f.task({ ...attachment, accountIdentity: "different-account" })).rejects.toThrow("ownership_unverified");
    await expect(f.task(attachment)).resolves.toMatchObject({ kind: "prepared" });
    await expect(f.task(attachment)).resolves.toMatchObject({ kind: "prepared" });
    expect(f.workers.call.mock.calls.at(-1)![2]).toMatchObject({ runId: f.runId, operation: {
      kind: "prepare", priorIdentity: f.identity, requirements: { identity: { runId: f.runId } },
    } });
    await expect(f.task({ ...f.operation, resumeFrom: undefined })).rejects.toThrow("ownership_unverified");
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(after).toEqual(before);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(JSON.stringify(lease.metadata)).not.toContain(f.owner.leaseOwner);
  });

  function launchRequirements(execution: NativeExecutionInput, identity: Awaited<ReturnType<typeof fixture>>["identity"]) {
    return environmentTaskOperationSchema.parse({ kind: "prepare", projectIds: [], requirements: runnerProviderLaunchRequirements({
      provider: execution.provider.kind === "acpx" ? "acpx" : "codex",
      ...(execution.provider.kind === "acpx" ? { acpxAgent: execution.provider.agent } : {}),
    }, identity, { model: execution.provider.model, config: { include_collaboration_mode_instructions: false } },
      "runtimeContext" in execution ? execution.runtimeContext : null, "Source policy") });
  }

  async function saveExecution(runId: string, execution: NativeExecutionInput) {
    await db.update(heartbeatRuns).set({ runnerProfileJson:
      sql`jsonb_set(${heartbeatRuns.runnerProfileJson}, '{nativeExecutionInput}', ${JSON.stringify(execution)}::jsonb)` }).where(eq(heartbeatRuns.id, runId));
  }

  function replacementContext(f: Awaited<ReturnType<typeof fixture>>, execution: NativeExecutionInput) {
    const context = new NativeExecutionContext(execution, 60_000); context.bindNativeLease(f.owner); contexts.push(context); return context;
  }

  it("binds Claude source preparation to A and attachment to current B's different policy", async () => {
    const f = await fixture("claude", "claude-opus-4-6"); await claimPluginTaskSourceRecovery(db, f);
    expect(f.sourceExecution.provider.model).not.toBe(f.execution.provider.model);
    const target = { ...f.identity, runId: f.runId, turnId: `turn-${f.runId}`, itemId: `item-${f.runId}` };
    const prepared = launchRequirements(f.execution, target);
    if (prepared.kind !== "prepare") throw new Error("invalid requirements fixture");
    await expect(f.task({ ...f.operation, requirements: { ...prepared.requirements, identity: f.identity } })).rejects.toThrow("ownership_unverified");
    await expect(f.task()).resolves.toMatchObject({ kind: "prepared" });
    await f.task({ kind: "check_project_auth", configurationId: "source-configuration", provider: f.authProvider, projectIds: [] });
    await expect(f.task(f.submit)).resolves.toMatchObject({ kind: "accepted" });
    const attachment = { ...f.operation, resumeFrom: undefined, priorIdentity: f.identity, requirements: prepared.requirements };
    await expect(f.task({ ...attachment, requirements: { ...f.operation.requirements, identity: target } })).rejects.toThrow("ownership_unverified");
    await expect(f.task(attachment)).resolves.toMatchObject({ kind: "prepared" });
    expect(f.workers.call).toHaveBeenCalledTimes(4);
    expect(f.workers.call.mock.calls[0][2].operation.requirements.model).toBe(f.sourceExecution.provider.model);
    expect(f.workers.call.mock.calls.at(-1)![2].operation.requirements.model).toBe(f.execution.provider.model);
  });

  it.each(["codex", "claude"] as const)("requires the distinct %s capability", async provider => {
    const f = await fixture(provider);
    await expect(claimPluginTaskSourceRecovery(db, { ...f,
      codexSourceRecoveryVersion: provider === "claude" ? 1 : undefined,
      acpxSourceRecoveryVersion: provider === "codex" ? 1 : undefined,
    })).rejects.toThrow("ownership_unverified");
    expect(f.workers.call).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude"] as const)("binds prepare, submit and attachment to the claimed %s provider", async provider => {
    const f = await fixture(provider); await claimPluginTaskSourceRecovery(db, f);
    const other = provider === "codex" ? "claude" : "codex";
    const relabelled = launchRequirements(f.build(f.sourceRunId, other), f.identity);
    if (relabelled.kind !== "prepare") throw new Error("invalid requirements fixture");
    await expect(f.task({ ...f.operation, requirements: relabelled.requirements })).rejects.toThrow("ownership_unverified");
    await expect(f.task({ kind: "submit", resumeFrom: f.resumeFrom, accountIdentity: f.accountIdentity,
      preparedLaunchId: "source-configuration", projectIds: [], bootstrapTicket: "synthetic-test-ticket",
      runner: { runnerId: f.identity.runnerInstanceId, leaseId: f.identity.environmentLeaseId, runId: f.identity.runId,
        sessionId: f.identity.normalizedSessionId, turnId: f.identity.turnId, itemId: f.identity.itemId,
        harness: other === "claude" ? "claude" : "codex", protocolMin: 1, protocolMax: 1 },
      launch: { runnerVersion: "source-fixture", runnerDigest: `sha256:${"a".repeat(64)}`, maxOutboxBytes: 262144,
        p0ReserveBytes: 65536, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } },
    })).rejects.toThrow("ownership_unverified");
    await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || '{"runnerTaskDispatched":true}'::jsonb` }).where(eq(environmentLeases.id, f.leaseId));
    await expect(f.task({ ...f.operation, resumeFrom: undefined, priorIdentity: f.identity,
      requirements: { ...relabelled.requirements, identity: { ...f.identity, runId: f.runId, turnId: `turn-${f.runId}`, itemId: `item-${f.runId}` } },
    })).rejects.toThrow("ownership_unverified");
    expect(f.workers.call).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude"] as const)("rejects a different current provider behind the %s source", async provider => {
    const f = await fixture(provider), execution = f.build(f.runId, provider === "codex" ? "claude" : "codex");
    await saveExecution(f.runId, execution);
    await expect(claimPluginTaskSourceRecovery(db, { ...f, context: replacementContext(f, execution),
      codexSourceRecoveryVersion: 1, acpxSourceRecoveryVersion: 1, matchesExecution: () => true,
    })).rejects.toThrow("ownership_unverified");
  });

  it("does not treat the ACPX Codex profile as native Codex or Claude", async () => {
    const f = await fixture("acpx_codex");
    await expect(claimPluginTaskSourceRecovery(db, { ...f, codexSourceRecoveryVersion: 1, acpxSourceRecoveryVersion: 1 })).rejects.toThrow("ownership_unverified");
  });

  it.each(["driverKind", "protocolVersion", "acpxVersion", "agent", "agentProfileVersion", "agentServerPackage", "agentServerVersion", "agentRuntimePackage", "agentRuntimeVersion", "commandDigest"] as const)("checks the qualified Claude profile field %s", async key => {
    const f = await fixture("claude"), execution = structuredClone(f.sourceExecution);
    if (execution.provider.kind !== "acpx") throw new Error("invalid Claude fixture");
    const profile = execution.provider.profile as unknown as Record<string, unknown>;
    profile[key] = typeof profile[key] === "number" ? Number(profile[key]) + 1 : key === "commandDigest" ? `sha256:${"0".repeat(64)}` : `${profile[key]}-other`;
    await saveExecution(f.sourceRunId, execution);
    await expect(claimPluginTaskSourceRecovery(db, f)).rejects.toThrow();
    const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.sourceLeaseId));
    expect(source.metadata?.runnerTaskSourceConsumer).toBeUndefined();
  });

  it("rejects equally stale saved and current Claude profiles despite decodable history", async () => {
    const f = await fixture("claude"), source = structuredClone(f.sourceExecution), current = structuredClone(f.execution);
    for (const execution of [source, current]) {
      if (execution.provider.kind !== "acpx") throw new Error("invalid Claude fixture");
      execution.provider.profile.commandDigest = `sha256:${"0".repeat(64)}`;
      expect(parseNativeExecutionInput(execution)).toEqual(execution);
    }
    await saveExecution(f.sourceRunId, source); await saveExecution(f.runId, current);
    await expect(claimPluginTaskSourceRecovery(db, { ...f, context: replacementContext(f, current) })).rejects.toThrow("ownership_unverified");
  });

  it.each(["source", "current"] as const)("revalidates the %s Claude profile after the worker reply", async changed => {
    const f = await fixture("claude"); await claimPluginTaskSourceRecovery(db, f);
    const perform = f.workers.call.getMockImplementation()!;
    f.workers.call.mockImplementation(async (...args) => {
      const result = await perform(...args), execution = structuredClone(changed === "source" ? f.sourceExecution : f.execution);
      if (execution.provider.kind !== "acpx") throw new Error("invalid Claude fixture");
      execution.provider.profile.commandDigest = `sha256:${"0".repeat(64)}`;
      await saveExecution(changed === "source" ? f.sourceRunId : f.runId, execution); return result;
    });
    await expect(f.task()).rejects.toThrow("reconcile the same task");
    await expect(f.task()).rejects.toThrow("ownership_unverified");
    expect(f.workers.call).toHaveBeenCalledTimes(1);
  });

  it.each(["model", "permission", "pinned", "effort", "readOnly", "context", "mode", "agent"] as const)("checks factory-normalized Claude launch policy: %s", async changed => {
    const f = await fixture("claude"); await claimPluginTaskSourceRecovery(db, f);
    const requirements = structuredClone(f.operation.requirements);
    if (changed === "model") requirements.model = "claude-opus-4-6";
    if (changed === "permission") requirements.settings.acpxPermissionMode = "deny-all";
    if (changed === "pinned") requirements.settings.acpxPermissionModePinned = false;
    if (changed === "effort") requirements.settings.claudeEffort = "high";
    if (changed === "readOnly") requirements.readOnly = true;
    if (changed === "context") requirements.runtimeContext = null;
    if (changed === "mode") requirements.settings.acpxMode = "agent";
    if (changed === "agent") requirements.settings.acpxAgent = "codex";
    await expect(f.task({ ...f.operation, requirements })).rejects.toThrow("ownership_unverified");
    expect(f.workers.call).not.toHaveBeenCalled();
  });

  it("keeps naked mismatches ordinary and malformed claims fail closed", async () => {
    const f = await fixture();
    for (const claim of [undefined, false, {}, true, "untrusted"]) {
      if (claim !== undefined) await db.update(environmentLeases).set({ metadata:
        sql`${environmentLeases.metadata} || ${JSON.stringify({ runnerTaskSourceRecovery: claim })}::jsonb` }).where(eq(environmentLeases.id, f.leaseId));
      await expect(f.task()).rejects.toThrow(claim ? "ownership_unverified" : "execution identity mismatch");
    }
    expect(f.workers.call).not.toHaveBeenCalled();
  });

  it("requires a complete claimed launch before any predecessor RPC", async () => {
    const f = await fixture(); await claimPluginTaskSourceRecovery(db, f);
    for (const operation of [
      { ...f.operation, resumeFrom: undefined }, { ...f.operation, accountIdentity: undefined },
      { ...f.operation, priorIdentity: f.identity },
      { ...f.operation, requirements: { ...f.operation.requirements, provider: "acpx" as const } },
    ]) await expect(f.task(operation)).rejects.toThrow("ownership_unverified");
    const submit = { kind: "submit" as const, resumeFrom: f.resumeFrom, accountIdentity: f.accountIdentity,
      preparedLaunchId: "source-configuration", projectIds: [], bootstrapTicket: "synthetic-test-ticket",
      runner: { runnerId: f.identity.runnerInstanceId, leaseId: f.identity.environmentLeaseId, runId: f.sourceRunId,
        sessionId: f.identity.normalizedSessionId, turnId: f.identity.turnId, itemId: f.identity.itemId, harness: "codex", protocolMin: 1, protocolMax: 1 },
      launch: { runnerVersion: "source-fixture", runnerDigest: `sha256:${"a".repeat(64)}`,
        maxOutboxBytes: 262144, p0ReserveBytes: 65536, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } } };
    for (const operation of [
      { ...submit, resumeFrom: undefined }, { ...submit, accountIdentity: undefined },
      { ...submit, preparedLaunchId: undefined }, { ...submit, launch: undefined },
      { ...submit, runner: { ...submit.runner, harness: "claude" } },
    ]) await expect(f.task(operation)).rejects.toThrow("ownership_unverified");
    expect(f.workers.call).not.toHaveBeenCalled();
  });

  it.each(["runnerInstanceId", "environmentLeaseId", "runId", "normalizedSessionId", "turnId", "itemId"] as const)("rejects a different source %s", async key => {
    const f = await fixture();
    await expect(claimPluginTaskSourceRecovery(db, { ...f, identity: { ...f.identity, [key]: randomUUID() } })).rejects.toThrow();
    expect(f.workers.call).not.toHaveBeenCalled();
  });

  it.each([["codex", "before-claim"], ["codex", "after-claim"], ["claude", "before-claim"], ["claude", "after-claim"]] as const)("rejects a stale same-boot %s coordinator context: %s", async (provider, point) => {
    const f = await fixture(provider); if (point === "after-claim") await claimPluginTaskSourceRecovery(db, f);
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
    await expect(claimPluginTaskSourceRecovery(db, { ...f, ...(mode === "capability" ? { codexSourceRecoveryVersion: undefined } : {}) })).rejects.toThrow();
    const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.sourceLeaseId));
    expect(source.metadata?.runnerTaskSourceConsumer).toBeUndefined(); expect(f.workers.call).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude"] as const)("pins the %s consumer and current account across retries", async provider => {
    const f = await fixture(provider), claim = await claimPluginTaskSourceRecovery(db, f);
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

  it("keeps the first source claim after dispatch, even when another source is eligible", async () => {
    const f = await fixture();
    const first = await claimPluginTaskSourceRecovery(db, f);
    await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || '{"runnerTaskDispatched":true,"runnerTaskResumeFrom":"source-task"}'::jsonb` })
      .where(eq(environmentLeases.id, f.leaseId));
    const alternateRunId = randomUUID(), alternateLeaseId = randomUUID(), alternateTaskId = "alternate-task";
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    const original = source.runnerProfileJson!.nativeExecutionInput as NativeExecutionInput;
    const execution = { ...original, binding: { ...original.binding, runId: alternateRunId } };
    await db.insert(heartbeatRuns).values({ ...source, id: alternateRunId, runnerProfileJson: { ...source.runnerProfileJson, nativeExecutionInput: execution } });
    const [result] = await db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId: alternateRunId,
      completionContractId: source.completionContractId!, serverFingerprint: "accepted-alternate", schemaStatus: "accepted",
      resultJson: { summary: "Accepted alternate" }, canonicalSha256: "accepted-alternate" }).returning();
    const [priorOwner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.insert(nativeRunFinalizations).values({ ...priorOwner, runId: alternateRunId, resultId: null,
      phase: "observed", leaseOwner: f.oldOwner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) });
    const identity = { ...f.identity, runId: alternateRunId, turnId: `turn-${alternateRunId}`, itemId: `item-${alternateRunId}` };
    const core = new DurablePrpControlPlane({ stateDirectory: join(root, alternateRunId), identity,
      expectedRunnerVersion: "source-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    core.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, { companyId: f.companyId, issueId: f.issueId,
      runId: alternateRunId, authorityRunId: alternateRunId, ...f.oldOwner }));
    try { await core.flushCheckpoint(); } finally { await core.stop(); }
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, alternateRunId));
    const [sourceLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.sourceLeaseId));
    const alternateLease = { ...sourceLease, id: alternateLeaseId, heartbeatRunId: alternateRunId, providerLeaseId: alternateTaskId };
    await db.insert(environmentLeases).values({ ...alternateLease, metadata: { ...sourceLease.metadata,
      runnerTaskSourceConsumer: undefined, runnerTaskIdentity: { runnerId: identity.runnerInstanceId, leaseId: identity.environmentLeaseId,
        runId: identity.runId, sessionId: identity.normalizedSessionId, turnId: identity.turnId, itemId: identity.itemId },
      remoteExecutionTermination: remoteTerminationReceipt(alternateLease, { providerLeaseId: alternateTaskId, state: "stopped" }) } });
    expect(await resolvePluginTaskResume(db, { ...f, priorIdentity: identity, inspectCheckpoint: true })).toBe(alternateTaskId);
    await expect(claimPluginTaskSourceRecovery(db, { ...f, identity, resumeFrom: alternateTaskId })).rejects.toThrow("ownership_unverified");
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(lease.metadata?.runnerTaskSourceRecovery).toEqual(first);
    const [unconsumed] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, alternateLeaseId));
    expect(unconsumed.metadata?.runnerTaskSourceConsumer).toBeUndefined();
    await expect(claimPluginTaskSourceRecovery(db, f)).resolves.toEqual(first);
  });

  it("refreshes only the same source under a newly acquired coordinator epoch", async () => {
    const f = await fixture(); await claimPluginTaskSourceRecovery(db, f);
    const owner = { ...f.owner, generation: f.owner.generation + 1, leaseOwner: randomUUID() };
    await db.update(nativeRunFinalizations).set({ controllerGeneration: owner.generation, leaseOwner: owner.leaseOwner })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    const context = new NativeExecutionContext(f.execution, 60_000); context.bindNativeLease(owner); contexts.push(context);
    const refreshed = await claimPluginTaskSourceRecovery(db, { ...f, context });
    expect(refreshed).toMatchObject({ identity: f.identity, resumeFrom: f.resumeFrom, controllerGeneration: owner.generation, contextId: context.id });
    await expect(f.task()).rejects.toThrow("context_owner_changed");
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

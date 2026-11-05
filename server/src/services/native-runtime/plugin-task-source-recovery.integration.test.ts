import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import WebSocket from "ws";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, environmentLeases, environments, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunResults, nativeRunnerCheckpoints, plugins, runUsageReceipts } from "@paperclipai/db";
import * as runnerRuntime from "../../vendor/paperclip-runner/index.js";
import { DurablePrpControlPlane, type DurablePrpCheckpoint, type NativeExecutionInput, type PrpEvent, type DurableRecoveryIdentity, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { executeEnvironmentTask, resolvePluginTaskResume } from "../environment-task-runtime.js";
import * as taskResume from "../plugin-task-resume.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { NativeExecutionContext } from "./native-execution-context.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { claimNativeRestartRecoveries, currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { loadNativeRunnerCheckpoint, nativeRunnerCheckpointWriter, restoreNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { claimPluginTaskSourceRecovery } from "./plugin-task-source-recovery.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { createNativeUsageDelivery } from "./native-usage-delivery.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { createNativeControllerRecovery } from "./native-controller-recovery.js";
import { createStoppedSourceExecutionContext, inspectStoppedPluginSourceRecovery, readPendingPluginSourceRecovery } from "./stopped-plugin-source-recovery.js";
import { nativeSha256 } from "./canonical.js";
import { registerLocalRuntimeApiServer } from "../../runtime-api.js";
import * as pluginRunner from "./plugin-runner-task.js";
import { closeWarmNativeSessionsForEnvironment, createRunnerdBackend, executePaperclipNativeSession, nativeControllerMigrationDescriptor } from "./native-session-executor.js";
import { nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import { createRunnerdCodexTransport as createCapabilityRunnerdCodexTransport, createNativeSessionBackend, defaultCapabilityRunnerdBinary,
  bindRunnerLaunchResources, createRunnerProviderLaunch, runnerLaunchRequirementsDigest, type RunnerProviderLaunchRequirements, type RunnerProcessLaunchSpec } from "@paperclipai/paperclip-runner";
import { canonicalNativeRuntimeContextDigest } from "../../vendor/paperclip-runner/index.js";
import { materializeAsset } from "./runtime-context.js";
const fakeCodex = resolve(import.meta.dirname, "../../../../packages/paperclip-runner/runner/target/debug/fake-codex-app-server");

const ingress = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../realtime/runner-prp-outbound.js", async () => ({
  ...await vi.importActual<typeof import("../../realtime/runner-prp-outbound.js")>("../../realtime/runner-prp-outbound.js"),
  connectRunnerPrpIngress: ingress.connect,
}));

describe.skipIf(!recoveryPostgresSupport.supported)("stopped source admission under the current native owner", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: ReturnType<typeof createDb>;
  let home: ReturnType<typeof createIsolatedTestHome>, root: string;
  const originalHome = process.env.PAPERCLIP_HOME;
  const contexts: NativeExecutionContext[] = [];
  beforeAll(async () => {
    home = createIsolatedTestHome(); process.env.PAPERCLIP_HOME = home.home;
    root = await realpath(await mkdtemp(join(tmpdir(), "plugin-source-recovery-")));
    database = await startRecoveryPostgres("plugin-source-recovery-"); db = createDb(database.connectionString);
  }, 60_000);
  afterEach(() => { for (const context of contexts.splice(0)) context.finish(); });
  afterAll(async () => {
    await database?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); home?.cleanup();
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = originalHome;
  });

  async function fixture(recoverable = false, cwd = "/workspace") {
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
    const runtimeContext = nativeRuntimeContextFixture();
    if (cwd !== "/workspace") {
      runtimeContext.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", content: Buffer.from("Complete the assigned work.\n"), mode: 0o444 }]);
      runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    }
    const build = (id: string) => buildNativeExecutionInput({ companyId, agentId, runId: id, normalizedSessionId: native.normalizedSessionId,
      provider: "codex", issue: { id: issueId, identifier: "SOURCE-1", title: "Continue once", description: null, workMode: "standard" },
      taskPrompt: "Continue once", workspace: { id, cwd, repoUrl: null, repoRef: null, branchName: null },
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
      completionContract: { id: prepared.completionContractId!, sha256: prepared.completionContractSha256!, schemaVersion: "paperclip.run-result.v1", contract: contract.contractJson as never },
      runtimeContext });
    const sourceExecution = build(sourceRunId), execution = build(runId);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...prepared.runnerProfileJson, nativeExecutionInput: sourceExecution } }).where(eq(heartbeatRuns.id, sourceRunId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: sourceRunId, phase: "observed", controllerBootId: oldOwner.bootId,
      controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: oldOwner.generation,
      leaseOwner: oldOwner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) });
    const identity = { runnerInstanceId: native.runnerInstanceId, environmentLeaseId: sourceLeaseId, runId: sourceRunId,
      normalizedSessionId: native.normalizedSessionId, turnId: `turn-${sourceRunId}`, itemId: `item-${sourceRunId}` };
    const oldWriter = nativeRunnerCheckpointWriter(db, { companyId, issueId, runId: sourceRunId, authorityRunId: sourceRunId, ...oldOwner });
    let checkpoint!: DurablePrpCheckpoint;
    const core = new DurablePrpControlPlane({ stateDirectory: join(root, sourceRunId), identity,
      expectedRunnerVersion: "source-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    if (recoverable) core.persistRunAttachTemplate({ provider: { kind: "codex", model: null, approvalPolicy: "never", readOnly: false,
      instructions: "Frozen source instructions.", runtimeContext: "runtimeContext" in sourceExecution ? sourceExecution.runtimeContext : null } });
    core.setCheckpointPersistence(async value => { checkpoint = value; await oldWriter(value); });
    await core.flushCheckpoint(); await core.stop();
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId: sourceRunId,
      completionContractId: prepared.completionContractId!, serverFingerprint: "accepted-source", schemaStatus: "accepted",
      resultJson: { summary: "Accepted once" }, canonicalSha256: "accepted-source" }).returning();
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, sourceRunId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(Date.now() - 1_000), resultJson: { summary: "Accepted once" } }).where(eq(heartbeatRuns.id, sourceRunId));
    const snapshot: PersistedNativeSession = { backendKind: "runner", driverKind: "codex_app_server", sessionId: "driver-thread",
      identity: { companyId, agentId, issueId, runId: sourceRunId, sessionId: native.normalizedSessionId }, providerSessionId: "provider-session",
      activeTurnId: null, pendingRuntimeRequests: [], goal: null };
    if (recoverable) await db.update(heartbeatRuns).set({ runnerProfileJson: { ...prepared.runnerProfileJson,
      nativeExecutionInput: sourceExecution, sessionCheckpoint: snapshot,
      nativeControllerRecovery: createNativeControllerRecovery(snapshot, { configDigest: `sha256:${"c".repeat(64)}`, processConfigDigest: null },
        { runId: sourceRunId, runnerInstanceId: identity.runnerInstanceId, normalizedSessionId: identity.normalizedSessionId }) } })
      .where(eq(heartbeatRuns.id, sourceRunId));
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native",
      nativeSessionId: native.normalizedSessionId, runnerInstanceId: native.runnerInstanceId,
      completionContractId: prepared.completionContractId, completionContractSha256: prepared.completionContractSha256,
      runnerProfileJson: { nativeExecutionInput: execution } });
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
      accountIdentity: "current-selected-account", matchesExecution: (previous: NativeExecutionInput) => previous.provider.kind === execution.provider.kind && previous.workspace.cwd === execution.workspace.cwd };
    const workers = { getWorker: () => ({ supportedMethods: ["environmentTask"] }), call: vi.fn(async (_id: string, _method: string, p: any) => {
      if (p.operation.kind === "prepare") return { kind: "prepared", taskId: p.taskId,
        launch: { configurationId: "source-configuration", requirementsDigest: `sha256:${"a".repeat(64)}`, provider: {} } };
      if (p.operation.kind === "check_project_auth") return { kind: "project_auth", taskId: p.taskId, provider: "openai", configurationId: p.operation.configurationId, allowed: true };
      return { kind: "accepted", taskId: p.taskId };
    }) };
    const operation = { kind: "prepare" as const, resumeFrom: input.resumeFrom,
      accountIdentity: input.accountIdentity, projectIds: [], requirements: { schema: "paperclip.runner.launch-requirements.v1" as const,
        identity, provider: "codex" as const, model: null, instructions: "Source policy", runtimeContext: null, settings: {}, approvalPolicy: "never" as const,
        readOnly: false, preparedConversation: false, includeCollaborationModeInstructions: false } };
    const task = (op: Parameters<typeof executeEnvironmentTask>[2]["operation"] = operation) => executeEnvironmentTask(db, workers as unknown as PluginWorkerManager,
      { companyId, leaseId, executionContext: context, operation: op });
    return { ...input, runId, sourceRunId, sourceLeaseId, environmentId, pluginId, agentId, issueId, owner, oldOwner, oldWriter, checkpoint, execution, operation, workers, task, build,
      snapshot, controlState: structuredClone(core.store.state) };
  }

  const description = { kind: "description" as const, taskId: "replacement-task", sourceRecoveryVersion: 1 as const,
    executionContextVersion: 1 as const, launchPreparationVersion: 1 as const, projectAuthCheckVersion: 1 as const,
    runner: { version: "source-fixture", digest: `sha256:${"a".repeat(64)}` } };
  function discovery(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<Parameters<typeof inspectStoppedPluginSourceRecovery>[0]> = {}) {
    return inspectStoppedPluginSourceRecovery({ db, execution: f.execution, description,
      target: { kind: "remote", transport: "sandbox", providerKey: "plugin", environmentId: f.environmentId,
        leaseId: f.leaseId, remoteCwd: ".", runnerTask: vi.fn(), sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: "replacement-task" } },
      readControlState: () => f.controlState,
      matchesExecution: (previous, digest) => digest === `sha256:${"c".repeat(64)}` && f.matchesExecution(previous), ...overrides });
  }

  it.skipIf(!existsSync(defaultCapabilityRunnerdBinary()) || !existsSync(fakeCodex)).each([false, true])("executes the next run through Core after abrupt idle process loss (restart=%s)", async restart => {
    const f = await fixture(true, root), binary = defaultCapabilityRunnerdBinary();
    await db.update(agents).set({ lifecycleRequiredPluginIds: [f.pluginId] }).where(eq(agents.id, f.agentId));
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, f.pluginId));
    await db.update(plugins).set({ manifestJson: { ...plugin.manifestJson, capabilities: ["environment.drivers.register", "agents.lifecycle.manage"],
      resourceLifecycle: ["agent_runtime"] } as never }).where(eq(plugins.id, f.pluginId));
    const api = createServer((_request, response) => response.end()); registerLocalRuntimeApiServer(api);
    await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
    const [sourceRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    const sourceExecution = sourceRun.runnerProfileJson!.nativeExecutionInput as NativeExecutionInput;
    const descriptor = nativeControllerMigrationDescriptor(sourceExecution, nativeToolContractFingerprintForTarget("remote", "codex"));
    const physicalRoot = join(root, f.sourceRunId), providerHome = join(physicalRoot, "home"); await mkdir(providerHome, { recursive: true });
    const report = join(physicalRoot, "completion.json"), callLog = join(physicalRoot, "calls");
    await writeFile(report, JSON.stringify({ schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Completed once",
      completionClaim: { contractRevision: sourceExecution.completionContract.contract.revision, objectiveSatisfied: true,
        criteria: sourceExecution.completionContract.contract.criteria.map(c => ({ criterionId: c.id, status: "satisfied", evidenceRefs: [] })), remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] }));
    const providerArgs = ["--state-file", join(physicalRoot, "fake-codex-state.json"), "--call-log", callLog, "--record-process-start", "--durable-turn-ids", "--terminal-result-file", report];
    const artifact = { version: "0.3.0", digest: `sha256:${createHash("sha256").update(await readFile(binary)).digest("hex")}` };
    const [sourceOwner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(nativeRunFinalizations).set({ phase: "observed", resultId: null, leaseOwner: f.oldOwner.leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(issues).set({ executionRunId: f.sourceRunId }).where(eq(issues.id, f.issueId));
    let retainedContext: RunnerProviderLaunchRequirements["runtimeContext"] = null;
    let sourceReport: PrpEvent | undefined, sourceLastSequence = 0;
    const sourceUsage = await createNativeUsageDelivery(db, { companyId: f.companyId, runId: f.sourceRunId,
      runnerInstanceId: f.identity.runnerInstanceId, provider: sourceExecution.provider,
      billing: { provider: "openai", biller: "openai", billingType: "metered_api" } });
    const original = createCapabilityRunnerdCodexTransport({ runnerBinary: binary, codexCommand: fakeCodex, codexArgs: providerArgs,
      stateDirectory: descriptor.root, runnerStateDirectory: join(physicalRoot, "runner"), sourceCodexHome: providerHome, prpIdentity: f.identity,
      lifecyclePolicy: sourceExecution.session.lifecyclePolicy, runnerProcessReconnectGraceMs: null,
      onAccountingEvent: async event => { sourceLastSequence = Math.max(sourceLastSequence, event.sourceSeq); if (event.eventType === "usage.reported") sourceReport = event; await sourceUsage.capture(event); },
      runtimeContext: "runtimeContext" in sourceExecution ? sourceExecution.runtimeContext : null,
      controlPlaneRegistration: async core => { retainedContext = (core.store.state.runAttachTemplate!.provider as Record<string, unknown>).runtimeContext as typeof retainedContext; core.setCheckpointPersistence(f.oldWriter); await core.start();
        return { connectUrl: core.connectUrl, release: () => core.stop() }; },
    });
    const kill = (pid: number | null) => { if (pid) try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
    let completed = false, launchCount = 0, hostStopped = false, detachedSourceAborted = false, lateSourceEventId = "";
    let sourceReceiptCount = 0, nextWarmRunId = "", lateWarmEventId = "";
    let warmSourceIdentity: DurableRecoveryIdentity | undefined;
    const observedAccounting: PrpEvent[] = [];
    let accountingHooks: NonNullable<Parameters<typeof runnerRuntime.createRunnerdCodexTransport>[0]> | undefined;
    const createTransport = runnerRuntime.createRunnerdCodexTransport;
    const transportSpy = vi.spyOn(runnerRuntime, "createRunnerdCodexTransport").mockImplementation(options => {
      accountingHooks = options;
      if (options?.onAccountingEvent) {
        const capture = options.onAccountingEvent;
        options.onAccountingEvent = async event => { observedAccounting.push(event); await capture(event); };
      }
      if (options?.onRecoveryAccountingEvent) {
        const capture = options.onRecoveryAccountingEvent;
        options.onRecoveryAccountingEvent = async (event, source) => { observedAccounting.push(event); await capture(event, source); };
      }
      return createTransport(options);
    });
    let child: ReturnType<typeof spawn> | undefined, launchSpec: RunnerProcessLaunchSpec | undefined, endpoint = "";
    const ownerFactory = pluginRunner.createPluginRunnerTaskOwner;
    const spy = vi.spyOn(pluginRunner, "createPluginRunnerTaskOwner").mockImplementation(input => {
      const owner = ownerFactory(input), launcher = owner.driver.runnerProcessLauncher!;
      owner.driver.runnerProcessLauncher = spec => { launchSpec = spec; launchCount++; return launcher(spec); }; return owner;
    });
    try {
      const session = await createNativeSessionBackend(sourceExecution, { codexTransportFactory: () => original.transport,
        environment: { PAPERCLIP_WORKSPACE_CWD: root }, dynamicTools: [] }).openSession({ identity: f.snapshot.identity, workingDirectory: root });
      await session.startTurn({ message: { role: "user", text: "Complete the source." } });
      for await (const event of session.events()) if (event.eventType === "turn.completed") break;
      const snapshot = await session.snapshot(); expect(snapshot.terminal?.runTerminalState).toBe("succeeded");
      await vi.waitFor(async () => { const state = JSON.parse(await readFile(join(physicalRoot, "runner", "runner-state.json"), "utf8")); expect(state.outbox).toEqual([]); });
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...sourceRun.runnerProfileJson, sessionCheckpoint: snapshot,
        nativeControllerRecovery: createNativeControllerRecovery(snapshot, { configDigest: descriptor.configDigest, processConfigDigest: null },
          { runId: f.sourceRunId, runnerInstanceId: f.identity.runnerInstanceId, normalizedSessionId: f.identity.normalizedSessionId }) } })
        .where(eq(heartbeatRuns.id, f.sourceRunId));
      await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: sourceOwner.resultId, leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.sourceRunId));
      const evidence = original.evidence(); await original.detachControllerForRestart(); kill(evidence.runnerPid); kill(evidence.codexPid);
      await vi.waitFor(() => { for (const pid of [evidence.runnerPid, evidence.codexPid]) if (pid) expect(() => process.kill(pid, 0)).toThrow(); });
      await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      const calls = async (method: string) => (await readFile(callLog, "utf8")).split("\n").filter(line => line === method).length;
      expect(await calls("turn/start")).toBe(1);
      sourceReceiptCount = (await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.sourceRunId))).length;
      expect(sourceReceiptCount).toBeGreaterThan(0); expect(sourceReport).toBeDefined();
      const credentialHome = join(physicalRoot, "credential"); await mkdir(credentialHome); await writeFile(join(credentialHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-fixture" }), { mode: 0o600 });
      const actualOutbound = await vi.importActual<typeof import("../../realtime/runner-prp-outbound.js")>("../../realtime/runner-prp-outbound.js");
      ingress.connect.mockImplementation(({ authority }) => {
        let wire: InstanceType<typeof actualOutbound.WsJsonWireConnection> | undefined;
        const ready = (async () => { const socket = new WebSocket(endpoint, { perMessageDeflate: false }); wire = new actualOutbound.WsJsonWireConnection(socket);
          await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
          const attachment = authority.attachWireConnection(wire); await vi.waitFor(() => expect(attachment.isAuthenticated()).toBe(true), { timeout: 10_000 }); })();
        return { ready, failure: new Promise<never>(() => {}), close: async () => { wire?.socket.terminate(); } };
      });
      f.workers.call.mockImplementation(async (...args: any[]) => {
        const params = args[2], op = params.operation, taskId = params.taskId;
        try { switch (op.kind) {
          case "describe": return { ...description, taskId, runner: artifact, warmTaskVersion: 1 };
          case "prepare": {
            if (op.requirements.identity.runId === f.runId && !lateSourceEventId) {
              // Deliver an equal late A receipt twice through the recovered hook;
              // B owns reconciliation while A keeps its original producer.
              const late = { ...sourceReport!, sourceEventId: `late-source-${f.sourceRunId}`,
                sourceSeq: Math.max(sourceLastSequence, ...observedAccounting.filter(event => event.runId === f.sourceRunId).map(event => event.sourceSeq)) + 1, emittedAt: new Date().toISOString() };
              expect(accountingHooks?.onRecoveryAccountingEvent).toBeTypeOf("function");
              await accountingHooks!.onRecoveryAccountingEvent!(late, f.identity);
              await accountingHooks!.onRecoveryAccountingEvent!(late, f.identity);
              lateSourceEventId = late.sourceEventId;
            }
            if (op.requirements.identity.runId === nextWarmRunId && !lateWarmEventId) {
              const previous = observedAccounting.find(event => event.runId === f.runId && event.eventType === "usage.reported");
              expect(previous).toBeDefined();
              const late = { ...previous!, sourceEventId: `late-warm-${f.runId}`,
                sourceSeq: Math.max(...observedAccounting.filter(event => event.runId === f.runId).map(event => event.sourceSeq)) + 1,
                emittedAt: new Date().toISOString() };
              await accountingHooks!.onAccountingEvent!(late);
              await accountingHooks!.onRecoveryAccountingEvent!(late, warmSourceIdentity!);
              lateWarmEventId = late.sourceEventId;
            }
            const provider = createRunnerProviderLaunch(bindRunnerLaunchResources(op.requirements as RunnerProviderLaunchRequirements, retainedContext!),
              { options: { codexArgs: providerArgs }, root: descriptor.root, cwd: root, codexHome: join(descriptor.root, "codex-home"), codexCommand: fakeCodex,
                providerNodeCommand: process.execPath, opencodeProxyPath: "", acpxSidecarPath: "" });
            return { kind: "prepared", taskId, launch: { configurationId: `configuration-${op.requirements.identity.runId}`,
              requirementsDigest: runnerLaunchRequirementsDigest(op.requirements), provider } };
          }
          case "check_project_auth": return { kind: "project_auth", taskId, configurationId: op.configurationId, provider: op.provider, allowed: true };
          case "submit": {
            expect(op).not.toHaveProperty("recoveryPurpose"); expect(op.runner.runId).toBe(f.sourceRunId); expect(params.runId).toBe(f.runId);
            const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
            const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()));
            const args = [...launchSpec!.args], stateIndex = args.indexOf("--state-dir"); args[stateIndex + 1] = join(physicalRoot, "runner");
            child = spawn(binary, [...args, "--listen-address", "0.0.0.0", "--listen-port", String(port), "--listen-path", `/api/runner/v1/connect/${f.sourceRunId}`],
              { env: launchSpec!.environment, stdio: "ignore", detached: true });
            endpoint = `ws://127.0.0.1:${port}/api/runner/v1/connect/${f.sourceRunId}`; await new Promise(resolve => setTimeout(resolve, 75));
            return { kind: "accepted", taskId };
          }
          case "read_state": {
            const state = JSON.parse(await readFile(join(physicalRoot, "runner", "runner-state.json"), "utf8"));
            if (restart && state.runId === f.runId && !detachedSourceAborted) {
              expect(f.context.active).toBe(true);
              f.context.abort(new Error("detached source startup expired after target rotation"));
              detachedSourceAborted = true;
            }
            return { kind: "state", taskId, state };
          }
          case "status": return { kind: "status", taskId, phase: hostStopped ? "cancelled" : child?.exitCode != null ? "failed" : "running", executionStopped: hostStopped || child?.exitCode != null, sessionStateAvailable: false };
          case "connection": return { kind: "connection", taskId, endpoint: { kind: "authenticated_websocket", websocketUrl: "wss://runner.example.test/runner", generation: "fixture", secretHeaders: [] } };
          case "stop": kill(child?.pid ?? null); hostStopped = true; return { kind: "accepted", taskId };
          case "complete": return { kind: "accepted", taskId };
          default: throw new Error(`Unexpected fake host operation ${op.kind}`);
        } } finally { args[5]?.(); }
      });
      const target = { kind: "remote" as const, transport: "sandbox" as const, providerKey: "plugin", environmentId: f.environmentId,
        leaseId: f.leaseId, remoteCwd: root, sandboxLeaseAcquisition: { outcome: "created" as const, providerLeaseId: "replacement-task" },
        runnerTask: (operation: unknown, context?: { executionContext?: unknown }) => executeEnvironmentTask(db, f.workers as unknown as PluginWorkerManager,
          { companyId: f.companyId, leaseId: f.leaseId, operation: operation as never, executionContext: context?.executionContext }) };
      const execution = { db, execution: f.execution, runnerInstanceId: f.identity.runnerInstanceId,
        managedAiCredentialIdentity: "synthetic-credential", managedAiAccountIdentity: f.accountIdentity, managedAiCredentialHome: credentialHome,
        runnerExecutionTarget: target, runnerIngressAuthorized: true as const };
      let recovery: Extract<Awaited<ReturnType<typeof claimNativeRestartRecoveries>>[number], { kind: "reattach_remote_runner" }> | undefined;
      if (restart) {
        await restoreNativeRunnerCheckpoint(db, sourceExecution.binding, descriptor.root);
        const source = await inspectStoppedPluginSourceRecovery({ db, execution: f.execution, target,
          description: { ...description, runner: artifact, warmTaskVersion: 1 },
          readControlState: () => JSON.parse(readFileSync(join(descriptor.root, "control-plane", "control-plane-state.json"), "utf8")),
          matchesExecution: (previous, digest) => digest === descriptor.configDigest && f.matchesExecution(previous) });
        expect(source).toBeDefined(); f.context.pluginSupported = true;
        await claimPluginTaskSourceRecovery(db, f);
        const backend = await createRunnerdBackend({ ...execution, executionContext: f.context,
          stoppedSourceRecovery: source, pluginTaskDescription: { ...description, runner: artifact, warmTaskVersion: 1 },
          controllerPersistence: { bootId: f.owner.bootId, runnerArtifact: artifact } });
        const admitted = await backend.recoverSession!(snapshot, { signal: f.context.signal });
        expect(admitted.recovered).toBe(true);
        if (!admitted.recovered) throw new Error("source fixture admission failed");
        await admitted.session!.detachControllerForRestart!();
        const pid = child!.pid; expect(pid).toBeDefined(); expect(await calls("turn/start")).toBe(1);
        await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
        const [claimed] = await claimNativeRestartRecoveries({ db, restartKind: "hard", runIds: [f.runId] });
        expect(claimed).toMatchObject({ kind: "reattach_remote_runner", sourceReconciliation: true });
        if (claimed.kind !== "reattach_remote_runner") throw new Error("source fixture restart was not claimed");
        recovery = claimed; expect(child!.pid).toBe(pid);
      }
      const result = await executePaperclipNativeSession({ ...execution, useRunnerd: true,
        leaseOwner: recovery?.leaseOwner ?? f.owner.leaseOwner, ...(recovery ? { restartRecovery: recovery } : {}) });
      completed = true;
      expect(result.exitCode).toBe(0); expect(result.sessionDisplayId).toBe(snapshot.providerSessionId);
      expect(await calls("turn/start")).toBe(2); expect(launchCount).toBe(1);
      expect(hostStopped).toBe(false); expect(detachedSourceAborted).toBe(restart);
      expect((await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId))).length).toBeGreaterThan(0);
      // B installs Core's tool declarations; the provider refresh keeps its thread.
      expect(await calls("process-start")).toBe(3);
      // The next ordinary warm attachment must observe C's current owner through
      // the reused transport, rather than freezing it under copied B authority.
      const nextRunId = randomUUID(), nextLeaseId = randomUUID(), nextExecution = f.build(nextRunId);
      nextWarmRunId = nextRunId;
      const priorState = JSON.parse(await readFile(join(physicalRoot, "runner", "runner-state.json"), "utf8"));
      expect(priorState.runId).toBe(f.runId);
      warmSourceIdentity = { runnerInstanceId: priorState.runnerInstanceId, environmentLeaseId: priorState.environmentLeaseId,
        runId: priorState.runId, normalizedSessionId: priorState.normalizedSessionId, turnId: priorState.turnId, itemId: priorState.itemId };
      const [accepted] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
      expect(accepted.schemaStatus).toBe("accepted");
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), resultJson: { summary: "Accepted B" } }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: accepted.id, leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
      const [retainedLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      const nextMetadata: Record<string, unknown> = { ...retainedLease.metadata, runnerTaskReused: true };
      delete nextMetadata.runnerTaskSourceRecovery; delete nextMetadata.runnerTaskSourceConsumer;
      await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, f.leaseId));
      await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
        status: "running", runtimeMode: "native", nativeSessionId: f.identity.normalizedSessionId, runnerInstanceId: f.identity.runnerInstanceId,
        completionContractId: nextExecution.completionContract.id, completionContractSha256: nextExecution.completionContract.sha256,
        runnerProfileJson: { nativeExecutionInput: nextExecution } });
      const currentController = await currentNativeControllerIdentity(), nextOwner = randomUUID();
      await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: nextRunId, phase: "observed",
        controllerBootId: currentController.bootId, controllerPid: currentController.pid, controllerProcessStartedAt: currentController.processStartedAt,
        controllerGeneration: 1, leaseOwner: nextOwner, leaseExpiresAt: new Date(Date.now() + 60_000) });
      await db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, f.issueId));
      await db.insert(environmentLeases).values({ companyId: f.companyId, id: nextLeaseId, environmentId: f.environmentId, issueId: f.issueId,
        heartbeatRunId: nextRunId, provider: retainedLease.provider, providerLeaseId: retainedLease.providerLeaseId,
        leasePolicy: "reuse_by_environment", status: "active", metadata: nextMetadata });
      const nextTarget = { ...target, leaseId: nextLeaseId,
        sandboxLeaseAcquisition: { outcome: "resumed" as const, providerLeaseId: retainedLease.providerLeaseId! },
        runnerTask: (operation: unknown, context?: { executionContext?: unknown }) => executeEnvironmentTask(db, f.workers as unknown as PluginWorkerManager,
          { companyId: f.companyId, leaseId: nextLeaseId, operation: operation as never, executionContext: context?.executionContext }) };
      const retainedPid = child!.pid;
      const nextResult = await executePaperclipNativeSession({ ...execution, execution: nextExecution, runnerExecutionTarget: nextTarget,
        leaseOwner: nextOwner, useRunnerd: true });
      expect(nextResult.exitCode).toBe(0); expect(nextResult.sessionDisplayId).toBe(snapshot.providerSessionId);
      expect(child!.pid).toBe(retainedPid); expect(launchCount).toBe(1); expect(await calls("turn/start")).toBe(3);
      expect((await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, nextRunId))).length).toBeGreaterThan(0);
      const lateReceipts = await db.select().from(runUsageReceipts).where(and(eq(runUsageReceipts.companyId, f.companyId),
        sql`${runUsageReceipts.receiptJson}->'producerEvent'->>'sourceEventId' = ${lateSourceEventId}`));
      expect(lateReceipts).toHaveLength(1); expect(lateReceipts[0].runId).toBe(f.sourceRunId);
      const lateWarmReceipts = await db.select().from(runUsageReceipts).where(and(eq(runUsageReceipts.companyId, f.companyId),
        sql`${runUsageReceipts.receiptJson}->'producerEvent'->>'sourceEventId' = ${lateWarmEventId}`));
      expect(lateWarmReceipts).toHaveLength(1); expect(lateWarmReceipts[0].runId).toBe(f.runId);
      await expect(accountingHooks!.onRecoveryAccountingEvent!(sourceReport!, f.identity)).rejects.toThrow("native_recovery_usage_source_unproven");
      expect((await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.sourceRunId)))).toHaveLength(sourceReceiptCount + 1);
      const [unchanged] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      expect(unchanged.status).toBe("succeeded"); expect(unchanged.resultJson).toEqual({ summary: "Accepted once" });
    } finally {
      if (completed) expect(await closeWarmNativeSessionsForEnvironment({ environmentId: f.environmentId, reason: "test cleanup" })).toMatchObject({ failed: 0 });
      spy.mockRestore(); transportSpy.mockRestore(); ingress.connect.mockReset(); kill(child?.pid ?? null);
      await new Promise<void>(resolve => api.close(() => resolve()));
      await original.transport.close().catch(() => undefined); const evidence = original.evidence(); kill(evidence.runnerPid); kill(evidence.codexPid);
    }
  }, 45_000);

  it("discovers the canonical stopped source without consuming it or changing its successful result", async () => {
    const f = await fixture(true);
    const discovered = await discovery(f);
    expect(discovered).toMatchObject({ identity: f.identity, checkpoint: f.snapshot, resumeFrom: f.resumeFrom,
      launch: { requirements: { identity: f.identity, instructions: "Frozen source instructions." } }, dispatched: false });
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(source.status).toBe("succeeded"); expect(source.resultJson).toEqual({ summary: "Accepted once" });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.sourceLeaseId));
    expect(lease.metadata?.runnerTaskSourceConsumer).toBeUndefined(); expect(f.workers.call).not.toHaveBeenCalled();
    expect(await discovery(f, { description: { ...description, sourceRecoveryVersion: undefined } })).toBeUndefined();
  });

  it("prefers ordinary retained suspension on a fresh physical lease before source-only gates", async () => {
    const f = await fixture(true);
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    const snapshot = { ...f.snapshot, goal: { status: "active" } } as PersistedNativeSession;
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson, sessionCheckpoint: snapshot,
      nativeControllerRecovery: createNativeControllerRecovery(snapshot, { configDigest: `sha256:${"c".repeat(64)}`, processConfigDigest: null },
        { runId: f.sourceRunId, runnerInstanceId: f.identity.runnerInstanceId, normalizedSessionId: f.identity.normalizedSessionId }) } })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || '{"runnerTaskSessionRetained":true}'::jsonb` })
      .where(eq(environmentLeases.id, f.sourceLeaseId));
    expect(await resolvePluginTaskResume(db, { ...f, priorIdentity: f.identity })).toBe(f.resumeFrom);
    const inspect = vi.fn(() => { throw new Error("ordinary continuation must not inspect a source-only launch"); });
    await expect(discovery(f, { matchesExecution: () => false, readControlState: inspect })).resolves.toBeUndefined();
    expect(inspect).not.toHaveBeenCalled(); expect(f.workers.call).not.toHaveBeenCalled();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(lease.metadata?.runnerTaskSourceRecovery).toBeUndefined();
  });

  it("propagates ordinary continuation inspection errors", async () => {
    const f = await fixture(true), failure = new Error("database lookup unavailable");
    const resolver = vi.spyOn(taskResume, "resolvePluginTaskResume").mockRejectedValue(failure);
    try { await expect(discovery(f)).rejects.toBe(failure); }
    finally { resolver.mockRestore(); }
    expect(f.workers.call).not.toHaveBeenCalled();
  });

  it("keeps an existing predecessor claim sticky when retained availability later appears", async () => {
    const f = await fixture(true); await claimPluginTaskSourceRecovery(db, f);
    await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || '{"runnerTaskSessionRetained":true}'::jsonb` })
      .where(eq(environmentLeases.id, f.sourceLeaseId));
    await expect(discovery(f)).resolves.toMatchObject({ identity: f.identity, resumeFrom: f.resumeFrom });
    expect(f.workers.call).not.toHaveBeenCalled();
  });

  it.each(["goal", "requests", "transition", "context-capability", "artifact", "configuration"])("refuses unsafe source discovery: %s", async mode => {
    const f = await fixture(true);
    if (mode === "goal" || mode === "requests") {
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      const snapshot = { ...f.snapshot, ...(mode === "goal" ? { goal: { status: "active" } } : { pendingRuntimeRequests: [{}] }) } as PersistedNativeSession;
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson, sessionCheckpoint: snapshot,
        nativeControllerRecovery: createNativeControllerRecovery(snapshot, { configDigest: `sha256:${"c".repeat(64)}`, processConfigDigest: null },
          { runId: f.sourceRunId, runnerInstanceId: f.identity.runnerInstanceId, normalizedSessionId: f.identity.normalizedSessionId }) } })
        .where(eq(heartbeatRuns.id, f.sourceRunId));
    }
    await expect(discovery(f, {
      ...(mode === "transition" ? { readControlState: () => ({ ...f.controlState, stagedRunAttachment: {} }) } : {}),
      ...(mode === "context-capability" ? { description: { ...description, executionContextVersion: undefined } } : {}),
      ...(mode === "artifact" ? { description: { ...description, runner: { ...description.runner, digest: `sha256:${"b".repeat(64)}` } } } : {}),
      ...(mode === "configuration" ? { matchesExecution: () => false } : {}),
    })).rejects.toThrow("source_recovery_unproven");
    expect(f.workers.call).not.toHaveBeenCalled();
  });

  it.each([false, true])("recovers the current owner before attach without inventing a B snapshot (dispatched=%s)", async dispatched => {
    const f = await fixture(true); await claimPluginTaskSourceRecovery(db, f);
    if (dispatched) {
      await f.task(); await f.task({ kind: "check_project_auth", configurationId: "source-configuration", provider: "openai", projectIds: [] });
      await f.task({ kind: "submit", resumeFrom: f.resumeFrom,
      accountIdentity: f.accountIdentity, preparedLaunchId: "source-configuration", projectIds: [], bootstrapTicket: "synthetic-test-ticket",
      runner: { runnerId: f.identity.runnerInstanceId, leaseId: f.identity.environmentLeaseId, runId: f.sourceRunId,
        sessionId: f.identity.normalizedSessionId, turnId: f.identity.turnId, itemId: f.identity.itemId, harness: "codex", protocolMin: 1, protocolMax: 1 },
      launch: { runnerVersion: "source-fixture", runnerDigest: `sha256:${"a".repeat(64)}`,
        maxOutboxBytes: 262144, p0ReserveBytes: 65536, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } },
      });
    }
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const controller = { ...await currentNativeControllerIdentity(), bootId: randomUUID() };
    const [claim] = await claimNativeRestartRecoveries({ db, controller, restartKind: "hard", runIds: [f.runId] });
    expect(claim).toMatchObject({ kind: "reattach_remote_runner", runId: f.runId, sourceReconciliation: true,
      remote: { kind: "plugin_task", leaseId: f.leaseId }, controllerGeneration: f.owner.generation + 1 });
    const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(current.runnerProfileJson?.sessionCheckpoint).toBeUndefined();
    expect(await loadNativeRunnerCheckpoint(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId })).toBeNull();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(source.status).toBe("succeeded"); expect(source.resultJson).toEqual({ summary: "Accepted once" });
  });

  it.each(["consumer", "source-profile", "unproven-target"])("holds ambiguous pre-attach restart evidence: %s", async changed => {
    const f = await fixture(true); await claimPluginTaskSourceRecovery(db, f);
    if (changed === "consumer") await db.update(environmentLeases).set({ metadata: sql`jsonb_set(${environmentLeases.metadata}, '{runnerTaskSourceConsumer,runId}', to_jsonb(${randomUUID()}::text))` }).where(eq(environmentLeases.id, f.sourceLeaseId));
    if (changed === "source-profile") await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: {} } }).where(eq(heartbeatRuns.id, f.sourceRunId));
    if (changed === "unproven-target") await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ runnerTaskIdentity: { runnerId: f.identity.runnerInstanceId,
      leaseId: f.identity.environmentLeaseId, runId: f.runId, sessionId: f.identity.normalizedSessionId, turnId: `turn-${f.runId}`, itemId: `item-${f.runId}` } })}::jsonb` }).where(eq(environmentLeases.id, f.leaseId));
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const [claim] = await claimNativeRestartRecoveries({ db, controller: { ...await currentNativeControllerIdentity(), bootId: randomUUID() }, restartKind: "hard", runIds: [f.runId] });
    expect(claim).toMatchObject({ kind: "awaiting_evidence", runId: f.runId, reason: "source_recovery_reference_unproven" });
    expect(f.workers.call).not.toHaveBeenCalled();
  });

  it("prioritizes the actual target journal over the old source reference after attach", async () => {
    const f = await fixture(true); await claimPluginTaskSourceRecovery(db, f);
    const identity = { ...f.identity, runId: f.runId, turnId: `turn-${f.runId}`, itemId: `item-${f.runId}` };
    const writer = nativeRunnerCheckpointWriter(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      authorityRunId: f.runId, ...f.owner });
    const core = new DurablePrpControlPlane({ stateDirectory: join(root, f.runId), identity,
      expectedRunnerVersion: "source-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    core.setCheckpointPersistence(writer); await core.flushCheckpoint(); await core.stop();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(await readPendingPluginSourceRecovery(db, { run, lease: { ...lease, metadata: lease.metadata! }, ownCheckpoint: true })).toBeNull();
    const snapshot = { ...f.snapshot, identity: { ...f.snapshot.identity, runId: f.runId } };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson, sessionCheckpoint: snapshot } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const [claim] = await claimNativeRestartRecoveries({ db, controller: { ...await currentNativeControllerIdentity(), bootId: randomUUID() }, restartKind: "hard", runIds: [f.runId] });
    expect(claim).toMatchObject({ kind: "reattach_remote_runner", runId: f.runId, remote: { kind: "plugin_task", leaseId: f.leaseId } });
    expect(claim).not.toHaveProperty("sourceReconciliation");
  });

  it("binds source preparation to canonical B despite verified attachment prompt staging", async () => {
    const f = await fixture(true), prepared = { ...f.execution, task: { ...f.execution.task, prompt: "Continue with staged attachment." } };
    const admission = { admissionSha256: nativeSha256(f.execution), preparedSha256: nativeSha256(prepared) };
    const context = await createStoppedSourceExecutionContext({ db, execution: prepared, preparedExecutionAdmission: admission,
      timeoutMs: 60_000, owner: f.owner }); contexts.push(context);
    expect(context.execution).toEqual(f.execution);
    await expect(claimPluginTaskSourceRecovery(db, { ...f, context })).resolves.toMatchObject({ contextId: context.id });
    await expect(createStoppedSourceExecutionContext({ db, execution: prepared, timeoutMs: 60_000, owner: f.owner })).rejects.toThrow("execution_changed");
    await expect(createStoppedSourceExecutionContext({ db, execution: prepared, preparedExecutionAdmission: { ...admission, admissionSha256: "foreign" },
      timeoutMs: 60_000, owner: f.owner })).rejects.toThrow("execution_changed");
  });

  it("authorizes only the claimed predecessor identity while preserving A's accepted outcome", async () => {
    const f = await fixture();
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await expect(f.task()).rejects.toThrow("execution identity mismatch");
    await claimPluginTaskSourceRecovery(db, f);
    const attachment = { ...f.operation, resumeFrom: undefined, priorIdentity: f.identity,
      requirements: { ...f.operation.requirements, identity: { ...f.identity, runId: f.runId, turnId: `turn-${f.runId}`, itemId: `item-${f.runId}` } } };
    await expect(f.task(attachment)).rejects.toThrow("ownership_unverified");
    expect(f.workers.call).not.toHaveBeenCalled();
    await expect(f.task()).resolves.toMatchObject({ kind: "prepared" });
    expect(f.workers.call.mock.calls[0][2]).toMatchObject({ runId: f.runId, operation: { requirements: { identity: f.identity } } });
    await f.task({ kind: "check_project_auth", configurationId: "source-configuration", provider: "openai", projectIds: [] });
    await expect(f.task({ kind: "submit", resumeFrom: f.resumeFrom,
      accountIdentity: f.accountIdentity, preparedLaunchId: "source-configuration", projectIds: [], bootstrapTicket: "synthetic-test-ticket",
      runner: { runnerId: f.identity.runnerInstanceId, leaseId: f.identity.environmentLeaseId, runId: f.sourceRunId,
        sessionId: f.identity.normalizedSessionId, turnId: f.identity.turnId, itemId: f.identity.itemId, harness: "codex", protocolMin: 1, protocolMax: 1 },
      launch: { runnerVersion: "source-fixture", runnerDigest: `sha256:${"a".repeat(64)}`,
        maxOutboxBytes: 262144, p0ReserveBytes: 65536, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } },
    })).resolves.toMatchObject({ kind: "accepted" });
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

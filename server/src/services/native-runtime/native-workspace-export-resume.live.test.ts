// Opt-in provider-boundary fault integration, not a Product E2E workflow.
// Real Daytona acquire/resume/stop/execute + production retry/reaper services;
// only the probe transport and first stop reply are deliberately unavailable.
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, completionContracts, createDb, environmentLeases, environments, heartbeatRuns, issues, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, agentWakeupRequests, plugins } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { heartbeatService } from "../heartbeat.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { retryNativeWorkspaceExport } from "./native-workspace-export-retry.js";
import { recordNativeFinalizationFailure } from "./native-run-finalizer.js";
import { classifyNativeWorkspaceFailure } from "./native-workspace-failure.js";

const enabled = process.env.PAPERCLIP_LIVE_EXPORT_RESUME === "1";
const describeLive = enabled ? describe : describe.skip;
const image = process.env.PAPERCLIP_LIVE_EXPORT_RESUME_IMAGE ?? "";
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

describeLive("live Daytona export-resume failure recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let plugin: any;
  let manifest: any;
  let sandbox: any;
  let lease: EnvironmentLease;
  let environment: Environment;
  const ids = { company: randomUUID(), agent: randomUUID(), environment: randomUUID(), run: randomUUID(), issue: randomUUID(),
    result: randomUUID(), contract: randomUUID(), lease: randomUUID(), action: randomUUID(), plugin: randomUUID() };
  const nonce = randomUUID();
  const bytes = `preserved-export-resume-${nonce}\n`;
  const digest = createHash("sha256").update(bytes).digest("hex");
  const config = { provider: "daytona", image, reuseLease: false, timeoutMs: 120_000, autoStopInterval: 10, autoDeleteInterval: 0 };
  const evidence: Record<string, unknown> = { kind: "live_provider_boundary_fault_integration", image, nonceSha256: digest };
  const methods: string[] = [];
  const providerCalls: unknown[] = [];
  evidence.providerCalls = providerCalls;
  let failProbe = false;
  let failStop = false;
  const handlers: Record<string, string> = { environmentResumeLease: "onEnvironmentResumeLease", environmentStopLease: "onEnvironmentStopLease", environmentExecute: "onEnvironmentExecute" };
  const manager = () => ({ isRunning: () => true,
    getWorker: () => ({ supportedMethods: Object.keys(handlers) }),
    call: async (_id: string, method: string, input: any) => {
      methods.push(method);
      if (method === "environmentExecute" && failProbe) { failProbe = false; evidence.probeFaultsInjected = Number(evidence.probeFaultsInjected ?? 0) + 1; throw new Error("Injected probe transport failure"); }
      if (method === "environmentStopLease" && failStop) { failStop = false; throw new Error("Injected stop transport failure"); }
      if (!handlers[method]) throw new Error("Unexpected provider operation");
      try {
        const result = await plugin[handlers[method]](input);
        providerCalls.push({ method, ...(method === "environmentExecute" ? { exitCode: result.exitCode, timedOut: result.timedOut } : {}),
          ...(method === "environmentResumeLease" ? { exactAllocation: result.providerLeaseId === lease.providerLeaseId, exactRoot: result.metadata?.remoteCwd === lease.metadata?.remoteCwd } : {}) });
        return result;
      } catch (error) {
        evidence.providerFailure = { method, errorName: (error as Error).name,
          // Function locations diagnose fixture failures without copying provider messages or credentials.
          frames: (error as Error).stack?.split("\n").slice(1, 6) };
        throw new Error("Live Daytona operation failed; provider details withheld");
      }
    },
  }) as unknown as PluginWorkerManager;
  function runtime() {
    const service = environmentRuntimeService(db, { pluginWorkerManager: manager() });
    const execute = service.execute.bind(service);
    service.execute = async input => {
      try { return await execute(input); }
      catch (error) {
        evidence.executionFailure = { errorName: (error as Error).name, frames: (error as Error).stack?.split("\n").slice(1, 6) };
        throw error;
      }
    };
    return service;
  }
  const scope = () => ({ driverKey: "daytona", companyId: ids.company, environmentId: ids.environment, issueId: ids.issue,
    config, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
  async function persistedLease() {
    return (await db.select().from(environmentLeases).where(eq(environmentLeases.id, ids.lease)))[0];
  }
  async function confirmStoppedAndPreserved() {
    await sandbox.refreshData();
    expect(sandbox.state).toBe("stopped");
    expect(sandbox.autoDeleteInterval).toBe(-1);
    evidence.providerAutoDeleteDisabled = true;
    await sandbox.start(60);
    const result = await sandbox.process.executeCommand(`sha256sum ${quote(`${lease.metadata!.remoteCwd}/preserved-${nonce}.txt`)}`, "/", undefined, 15);
    expect(result.exitCode).toBe(0);
    expect(result.result.split(/\s/)[0]).toBe(digest);
    await sandbox.stop(60);
    await sandbox.refreshData();
    expect(sandbox.state).toBe("stopped");
  }
  beforeAll(async () => {
    if (!process.env.DAYTONA_API_KEY || !/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Explicit Daytona credentials and immutable image required");
    temporary = await startEmbeddedPostgresTestDatabase("live-export-resume-"); db = createDb(temporary.connectionString);
    ({ default: plugin } = await import(new URL("../../../../packages/plugins/sandbox-providers/daytona/dist/plugin.js", import.meta.url).href));
    plugin = plugin.definition;
    ({ default: manifest } = await import(new URL("../../../../packages/plugins/sandbox-providers/daytona/dist/manifest.js", import.meta.url).href));
    await db.insert(companies).values({ id: ids.company, name: "Disposable export lifecycle", issuePrefix: "LXR" });
    await db.insert(agents).values({ id: ids.agent, companyId: ids.company, name: "No provider turn", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: ids.environment, name: `Lifecycle ${nonce}`, driver: "sandbox", config });
    environment = (await db.select().from(environments).where(eq(environments.id, ids.environment)))[0] as unknown as Environment;
    await db.insert(plugins).values({ id: ids.plugin, pluginKey: manifest.id, packageName: "@paperclipai/plugin-daytona", version: manifest.version,
      apiVersion: 1, categories: ["automation"], manifestJson: manifest, status: "ready", installOrder: 1 });
    await db.insert(issues).values({ id: ids.issue, companyId: ids.company, title: "Preserved accepted result", status: "blocked", assigneeAgentId: ids.agent });
    await db.insert(completionContracts).values({ id: ids.contract, companyId: ids.company, issueId: ids.issue, revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "live-test", risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { objective: "Preserve saved work" }, canonicalSha256: digest, createdByActorType: "system", createdByActorId: "live-test" });
    await db.insert(heartbeatRuns).values({ id: ids.run, companyId: ids.company, agentId: ids.agent, status: "failed", runtimeMode: "native", nativeIssueId: ids.issue, nativePhase: "terminal_failure", completionContractId: ids.contract });
    await db.insert(nativeRunResults).values({ id: ids.result, companyId: ids.company, issueId: ids.issue, runId: ids.run, completionContractId: ids.contract, serverFingerprint: digest, schemaStatus: "accepted", resultJson: { work: "preserve saved work" }, canonicalSha256: digest });
    await db.insert(nativeRunFinalizations).values({ runId: ids.run, companyId: ids.company, issueId: ids.issue, phase: "terminal_failure", resultId: ids.result, failureCode: "native_workspace_sync_out_unsafe_archive" });
    await db.insert(issueRecoveryActions).values({ id: ids.action, companyId: ids.company, sourceIssueId: ids.issue, kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: ids.agent, cause: "native_workspace_sync_out_unsafe_archive", fingerprint: ids.run, evidence: { runId: ids.run }, nextAction: "Repair saved files" });
    let setupPhase = "acquire";
    try {
      const acquired = await plugin.onEnvironmentAcquireLease({ driverKey: "daytona", companyId: ids.company, environmentId: ids.environment,
        issueId: ids.issue, runId: ids.run, agentId: ids.agent, adapterType: "paperclip_runner", config });
      setupPhase = "sdk_lookup";
      const require = createRequire(new URL("../../../../packages/plugins/sandbox-providers/daytona/package.json", import.meta.url));
      const { Daytona } = require("@daytonaio/sdk");
      sandbox = await new Daytona({ apiKey: process.env.DAYTONA_API_KEY }).get(acquired.providerLeaseId);
      const metadata = { ...acquired.metadata, provider: "daytona", pluginId: ids.plugin, sandboxProviderPlugin: true };
      await db.insert(environmentLeases).values({ id: ids.lease, companyId: ids.company, environmentId: ids.environment, issueId: ids.issue,
        heartbeatRunId: ids.run, status: "active", leasePolicy: "ephemeral", provider: "daytona", providerLeaseId: acquired.providerLeaseId, metadata });
      lease = await persistedLease() as unknown as EnvironmentLease;
      setupPhase = "write";
      const wrote = await sandbox.process.executeCommand(`printf %s ${quote(bytes)} > ${quote(`${metadata.remoteCwd}/preserved-${nonce}.txt`)}`, "/", undefined, 15);
      if (wrote.exitCode !== 0) throw new Error("Write failed");
      setupPhase = "initial_stop";
      const receipt = await plugin.onEnvironmentStopLease(scope());
      expect(receipt.state).toBe("stopped");
      await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
        metadata: { ...metadata, remoteExecutionTermination: remoteTerminationReceipt(lease, receipt) } }).where(eq(environmentLeases.id, ids.lease));
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v1", state: "prepared", descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: randomUUID(), leaseId: ids.lease, providerLeaseId: lease.providerLeaseId, remoteCwd: metadata.remoteCwd, resourceDisposition: "destroy" } } }).where(eq(heartbeatRuns.id, ids.run));
    } catch (error) {
      evidence.setupFailure = { phase: setupPhase, errorType: (error as Error).name };
      throw new Error(`Live fixture setup failed at ${setupPhase}; provider details withheld`);
    }
  }, 180_000);
  afterAll(async () => {
    try {
      if (sandbox) {
        if (sandbox.labels?.["paperclip-company-id"] !== ids.company || sandbox.labels?.["paperclip-environment-id"] !== ids.environment || sandbox.labels?.["paperclip-run-id"] !== ids.run) throw new Error("Fixture cleanup ownership mismatch");
        await sandbox.delete(60);
        evidence.cleanupPassed = true;
      }
    } catch { throw new Error("Exact live fixture cleanup failed; provider details withheld"); }
    finally {
      if (temporary) await temporary.cleanup();
      if (process.env.PAPERCLIP_EXPORT_RESUME_EVIDENCE_PATH) await writeFile(process.env.PAPERCLIP_EXPORT_RESUME_EVIDENCE_PATH, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    }
  }, 90_000);
  it("stops after a failed probe, and recovers a failed stop through a fresh runtime", async () => {
    const request = () => ({ db, companyId: ids.company, issueId: ids.issue, actionId: ids.action, runId: ids.run, actorId: "live-test",
      repairNote: "Provider-boundary fault integration preserves exact synthetic nonce bytes", environmentRuntime: runtime() });
    failProbe = true;
    await expect(retryNativeWorkspaceExport(request())).rejects.toThrow("Resume and repair");
    expect(await persistedLease()).toMatchObject({ status: "released", cleanupStatus: "success", metadata: { remoteExecutionTermination: { state: "stopped" } } });
    await confirmStoppedAndPreserved();
    evidence.failedProbeCompensated = true;
    failProbe = true; failStop = true;
    await expect(retryNativeWorkspaceExport(request())).rejects.toThrow("Resume and repair");
    const pending = await persistedLease();
    expect(pending).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed", metadata: { pendingCleanupInFlight: false, nativeWorkspaceExportResume: { runId: ids.run, leaseId: ids.lease } } });
    expect(pending.metadata?.remoteExecutionTermination).toBeUndefined();
    await sandbox.refreshData(); expect(sandbox.state).toBe("started");
    evidence.failedStopDurablyTracked = true;
    // Load a fresh worker module as well as a fresh controller service. The
    // reaper must recover from durable rows with no cached provider handle.
    const restartedPlugin = (await import(`${new URL("../../../../packages/plugins/sandbox-providers/daytona/dist/plugin.js", import.meta.url).href}?restart=${nonce}`)).default.definition;
    expect(restartedPlugin).not.toBe(plugin);
    plugin = restartedPlugin;
    const fresh = runtime();
    await heartbeatService(db, { environmentRuntime: fresh }).sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(await persistedLease()).toMatchObject({ status: "released", cleanupStatus: "success", metadata: { remoteExecutionTermination: { state: "stopped" } } });
    expect((await persistedLease()).metadata?.nativeWorkspaceExportResume).toBeUndefined();
    await confirmStoppedAndPreserved();
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect((await db.select().from(nativeRunFinalizations))[0]).toMatchObject({ phase: "terminal_failure", resultId: ids.result });
    expect(methods.filter(m => m === "environmentResumeLease")).toHaveLength(2);
    expect(methods.filter(m => m === "environmentStopLease")).toHaveLength(3);
    expect(evidence.probeFaultsInjected).toBe(2);
    evidence.restartStopPreservedBytes = true; evidence.noNewProviderTurn = true; evidence.noDestroyBeforeFixtureCleanup = true;
  }, 180_000);
  it("preserves an ephemeral allocation after injected transient export exhaustion and a failed initial stop", async () => {
    await plugin.onEnvironmentResumeLease(scope());
    await db.update(environmentLeases).set({ status: "active", cleanupStatus: null, releasedAt: null,
      metadata: { ...(await persistedLease()).metadata, remoteExecutionTermination: undefined } }).where(eq(environmentLeases.id, ids.lease));
    await db.update(heartbeatRuns).set({ status: "running", nativePhase: "result_accepted" }).where(eq(heartbeatRuns.id, ids.run));
    await db.update(nativeRunFinalizations).set({ phase: "result_accepted", failureCode: null, failureDetail: null }).where(eq(nativeRunFinalizations.runId, ids.run));
    const acceptedBefore = await db.select().from(nativeRunResults);
    // Deliberate fixture-only transport failure at the finalizer boundary. No
    // disk pressure, provider outage, or successful physical copyback is claimed.
    for (let attempt = 0; attempt < 3; attempt++) {
      const failure = classifyNativeWorkspaceFailure(new Error("Injected fixture export transport unavailable"));
      await recordNativeFinalizationFailure({ db, runId: ids.run, error: new Error(failure.failureCode),
        failureScope: "workspace", projectRunStatus: true, permanent: failure.permanent });
    }
    expect(await persistedLease()).toMatchObject({ status: "pending_cleanup", leasePolicy: "ephemeral", metadata: { reuseLease: false, nativeWorkspaceExportResume: { purpose: "terminal_export", resultId: ids.result } } });
    failStop = true;
    await runtime().releaseRunLeases(ids.run, "failed", undefined, "stop_and_retain");
    expect(await persistedLease()).toMatchObject({ status: "pending_cleanup", metadata: { pendingCleanupInFlight: false } });
    await sandbox.refreshData(); expect(sandbox.state).toBe("started");
    plugin = (await import(`${new URL("../../../../packages/plugins/sandbox-providers/daytona/dist/plugin.js", import.meta.url).href}?exhaustion-restart=${nonce}`)).default.definition;
    await heartbeatService(db, { environmentRuntime: runtime() }).sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(await persistedLease()).toMatchObject({ status: "released", metadata: { remoteExecutionTermination: { providerLeaseId: lease.providerLeaseId, state: "stopped" } } });
    await confirmStoppedAndPreserved();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.cause, "native_workspace_sync_out_retry_exhausted"));
    expect(action).toMatchObject({ status: "active", ownerType: "board" });
    const queued = await retryNativeWorkspaceExport({ db, companyId: ids.company, issueId: ids.issue, runId: ids.run, actionId: action.id,
      actorId: "live-test", repairNote: "Fixture-only export transport fault removed; exact nonce and allocation preserved", environmentRuntime: runtime() });
    expect(queued).toMatchObject({ resultId: ids.result, leaseId: ids.lease, status: "queued" });
    expect(await db.select().from(nativeRunResults)).toEqual(acceptedBefore);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    evidence.ephemeralExhaustionRestartPreserved = true;
    evidence.genericExportRetryAdmittedWithoutProviderTurn = true;
    evidence.genericCopybackNotAttempted = true;
  }, 180_000);
});

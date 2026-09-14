// Invoked only by the retained-runner integration fixture. Each invocation is
// a fresh controller process with the real executor and isolated test database.
import { readFile } from "node:fs/promises";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { eq } from "drizzle-orm";
import { createDb, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { environmentRuntimeService } from "../environment-runtime.ts";
import { currentNativeControllerIdentity } from "./native-restart-recovery.ts";
import { createRemoteRunnerRecoveryControls } from "./remote-runner-recovery-controls.ts";
import { assertNoNativeRunnerClosing } from "./remote-runner-recovery.ts";
import { withRuntimeServiceLeaseLock } from "../runtime-services/retention.ts";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.ts";
import { persistHeartbeatRunProcessMetadata } from "../run-process-metadata.ts";
import { randomUUID } from "node:crypto";
import { closeWarmNativeSessionsForEnvironment, executePaperclipNativeSession, recoverRetainedRemoteNativeSessions } from "./native-session-executor.ts";

const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
try {
  if (!process.send || !["active", "idle"].includes(process.argv[3])) throw new Error("Fixture requires IPC and a controller mode");
  const config = JSON.parse(await readFile(process.argv[2], "utf8"));
  const mode = process.argv[3], db = createDb(config.connectionString);
  setDefaultCACertificates([...getCACertificates("default"), await readFile(config.caPath)]);
  const rpc = async (pluginId, method, params) => {
    const response = await fetch(config.providerUrl, { method: "POST", headers: { "content-type": "application/json", "x-fixture-token": config.token },
      body: JSON.stringify({ pluginId, method, params }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Fixture provider response ${response.status}`);
    return response.json();
  };
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
    isRunning: () => true,
    getWorker: () => ({ supportedMethods: ["environmentRunProcessControl", "environmentRunnerRecovery", "environmentRunnerRecoveryExecute"] }),
    call: rpc,
  } });
  const onLog = async (stream, chunk) => { process[stream].write(chunk); };
  const recover = async () => {
    const recovery = await recoverRetainedRemoteNativeSessions({ db, environmentRuntime: runtime, onLog });
    const result = recovery.results.find(result => result.runId === config.execution.binding.runId);
    const replay = result?.state === "recovered" ? await recoverRetainedRemoteNativeSessions({ db, environmentRuntime: runtime, onLog }) : null;
    const lease = { id: config.processReference.environmentLeaseId, companyId: config.execution.binding.companyId,
      provider: "daytona", providerLeaseId: config.processReference.providerLeaseId };
    let admission;
    try { await withRuntimeServiceLeaseLock(db, lease, tx => assertNoNativeRunnerClosing(tx, lease)); admission = "admitted"; }
    catch (error) { admission = error.message; }
    return { result, results: recovery.results, replay, admission };
  };
  if (mode === "active") {
    const controller = await currentNativeControllerIdentity();
    await db.update(nativeRunFinalizations).set({ controllerBootId: controller.bootId, controllerPid: controller.pid,
      controllerProcessStartedAt: controller.processStartedAt }).where(eq(nativeRunFinalizations.runId, config.execution.binding.runId));
    const controls = createRemoteRunnerRecoveryControls({ companyId: config.execution.binding.companyId, runId: config.execution.binding.runId,
      process: config.processReference, runtime });
    const result = await executePaperclipNativeSession({ db, environmentRuntime: runtime, execution: config.execution, runnerInstanceId: config.identity.runnerInstanceId,
      leaseOwner: config.claim.leaseOwner, restartRecovery: { ...config.claim, process: config.processReference }, useRunnerd: true, runnerIngressAuthorized: true,
      runnerEnvironment: { HOME: config.fixtureHome, CODEX_HOME: config.fixtureHome, PATH: process.env.PATH }, onLog,
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", providerKey: "daytona", environmentId: config.processReference.environmentId,
        leaseId: config.processReference.environmentLeaseId, remoteCwd: config.processReference.workspaceRoot,
        runner: { execute: async command => ({ ...await controls.execute(command), pid: null, startedAt: null, signal: null }) },
        nativeRunnerRecovery: controls.nativeRunnerRecovery, getRunnerIngressEndpoint: controls.getRunnerIngressEndpoint,
        effectiveCapabilities: { runnerWebSocketIngress: true, reusableLeases: true }, reusableLeaseConfigured: true } });
    if (result.errorMessage) throw new Error(result.errorMessage);
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, config.execution.binding.runId));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, config.execution.binding.runId));
    await send({ state: "ready", mode });
  } else {
    await send({ state: "ready", mode, ...await recover() });
  }
  process.on("message", async message => {
    if (message?.action === "next_run" && mode === "idle") {
      try {
        const execution = structuredClone(config.execution), runId = randomUUID(), leaseId = randomUUID();
        execution.binding.runId = runId;
        const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId: execution.binding.companyId,
          agentId: execution.binding.agentId, status: "running", nativeSessionId: execution.session.normalizedSessionId,
          runnerInstanceId: config.identity.runnerInstanceId, contextSnapshot: { issueId: execution.binding.issueId } }).returning();
        const [issue] = await db.update(issues).set({ status: "in_progress", executionRunId: runId }).where(eq(issues.id, execution.binding.issueId)).returning();
        const [original] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, config.processReference.environmentLeaseId));
        const lease = await withRuntimeServiceLeaseLock(db, original, async tx => {
          await assertNoNativeRunnerClosing(tx, original);
          const metadata = { ...original.metadata };
          delete metadata.nativeWarmRunnerRetention; delete metadata.nativeWarmRunnerClose; delete metadata.runtimeServiceProcessOwner;
          await tx.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, original.id));
          const [created] = await tx.insert(environmentLeases).values({ ...original, id: leaseId, heartbeatRunId: runId,
            status: "active", releasedAt: null, createdAt: new Date(), updatedAt: new Date(), metadata }).returning();
          return created;
        });
        await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: leaseId });
        const [prepared] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...prepared.runnerProfileJson, nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
        await db.insert(nativeRunFinalizations).values({ companyId: execution.binding.companyId, issueId: issue.id, runId, phase: "observed" });
        let receivedProcesses = 0;
        const result = await executePaperclipNativeSession({ db, environmentRuntime: runtime, execution,
          runnerInstanceId: config.identity.runnerInstanceId, useRunnerd: true, runnerIngressAuthorized: true, onLog,
          runnerEnvironment: { HOME: config.fixtureHome, CODEX_HOME: config.fixtureHome, PATH: process.env.PATH },
          onSpawn: async metadata => { receivedProcesses += 1; await persistHeartbeatRunProcessMetadata(db, runId, metadata, leaseId); },
          runnerExecutionTarget: { kind: "remote", transport: "sandbox", providerKey: "daytona", environmentId: lease.environmentId,
            leaseId, remoteCwd: config.processReference.workspaceRoot, reusableLeaseConfigured: true,
            effectiveCapabilities: { runnerWebSocketIngress: true, reusableLeases: true },
            runner: { execute: command => rpc(lease.metadata.pluginId, "fixtureCommand", { runId, leaseId, command }) },
            getRunnerIngressEndpoint: async request => {
              const wire = (await rpc(lease.metadata.pluginId, "environmentRunnerRecovery", {
                runId, operation: "ingress", owner: config.processReference.remoteProcessIdentity,
                workspaceConnection: config.processReference.workspaceConnection, path: request.path })).endpoint;
              const endpoint = { ...wire, close: async () => undefined, refresh: async () => endpoint };
              return endpoint;
            },
          } });
        if (result.errorMessage) throw new Error(result.errorMessage);
        await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, runId));
        await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
        await send({ state: "next_run_completed", runId, leaseId, receivedProcesses, result });
      } catch (error) { await send({ state: "error", message: error?.stack ?? String(error) }); }
      return;
    }
    if (message?.action === "recover" && mode === "idle") {
      try { await send({ state: "recovery_retry", ...await recover() }); }
      catch (error) { await send({ state: "error", message: String(error) }); }
      return;
    }
    if (message?.action !== "close") return;
    try {
      const result = await closeWarmNativeSessionsForEnvironment({ environmentId: config.processReference.environmentId, reason: "fixture review finished" });
      await send({ state: "closed", result });
      process.exit(0);
    } catch (error) { await send({ state: "error", message: String(error) }); process.exit(1); }
  });
} catch (error) {
  if (process.send) await send({ state: "error", message: error?.stack ?? String(error) }).catch(() => undefined);
  process.exit(1);
}

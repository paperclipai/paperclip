import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { PluginEnvironmentRunnerRecoveryExecuteParams } from "@paperclipai/plugin-sdk";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "../../vendor/paperclip-runner/index.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import { environmentService } from "../environments.js";
import { readProcessStartedAt } from "../hot-restart.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { withRuntimeServiceLeaseLock } from "../runtime-services/retention.js";
import { createNativeRemoteIdleLifecycle, type NativeRemoteIdleLifecycle } from "./native-remote-idle-lifecycle.js";
import { withNativeRemoteWarmRetention } from "./native-remote-warm-retention.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { buildNativeHarnessBackupManifest, providerSessionIdentityFromDurableProviderState, syncRemoteRunnerDirectoryOut } from "./native-session-executor.js";
import { createNativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";
import { seedRemoteDispatchFixture } from "./remote-dispatch.test-fixture.js";
import { assertNoNativeRunnerClosing, nativeRemoteRetentionAuthority } from "./remote-runner-recovery.js";

const fakeCodex = resolve(import.meta.dirname, "../../../../packages/paperclip-runner/runner/target/debug/fake-codex-app-server");
const support = await getEmbeddedPostgresTestSupport();
const available = support.supported && existsSync(fakeCodex) && existsSync(defaultCapabilityRunnerdBinary());
const exec = promisify(execFile);

async function waitUntil(label: string, condition: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopOwned(pid: number | null, root: string) {
  if (!pid || !alive(pid)) return;
  const result = await exec("ps", ["-p", String(pid), "-o", "command="]);
  if (!result.stdout.includes(root)) throw new Error("Fixture process ownership changed");
  process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  await waitUntil("fixture process exit", () => !alive(pid));
}

async function json(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

// Real Rust runner, PRP suspension, command/archive execution, PostgreSQL and
// independent HTTP process. The provider RPC/remote kernel identity boundary
// is simulated on the host; this is not a Daytona or Linux ownership proof.
(available ? describe : describe.skip)("retained idle lifecycle with a real runner and checkpoint", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, root: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperclip-real-idle-"));
    process.env.PAPERCLIP_HOME = root;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = join(root, "runner-sessions");
    database = await startEmbeddedPostgresTestDatabase("paperclip-real-idle-db-");
    db = createDb(database.connectionString);
  });
  afterAll(async () => {
    await database?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousStateDirectory === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
    else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(["saved", "archive_failure", "controller_takeover", "takeover_archive_failure"] as const)("suspends the runner while preserving the HTTP service (%s)", async outcome => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    const caseRoot = join(root, runId), stateDirectory = join(caseRoot, "remote-state");
    const backup = join(process.env.PAPERCLIP_RUNNER_STATE_DIR!, createHash("sha256").update(runId).digest("hex"), "failover-backups/current");
    const fixtureHome = join(caseRoot, "empty-provider-home");
    await mkdir(stateDirectory, { recursive: true });
    await mkdir(fixtureHome);
    await db.insert(companies).values({ id: companyId, name: "Real idle checkpoint", issuePrefix: "I" + companyId.slice(0, 6) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Developer" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Keep the app running", status: "in_progress", assigneeAgentId: agentId, executionRunId: runId });
    const fixture = await seedRemoteDispatchFixture(db, { companyId, agentId, runId, issueId, hostCwd: join(caseRoot, "app") });
    const execution = structuredClone(fixture.execution);
    execution.session.lifecyclePolicy = { mode: "warm", idleTimeoutMs: 300_000 };
    const identity = { runnerInstanceId: randomUUID(), environmentLeaseId: fixture.lease.id, runId,
      normalizedSessionId: fixture.native.normalizedSessionId, turnId: fixture.native.turnId, itemId: fixture.native.itemId };
    const runnerStateFile = join(stateDirectory, "runner/runner-state.json");
    const appFile = join(caseRoot, "app/App.jsx"), portFile = join(caseRoot, "http.json"), serviceToken = randomUUID();
    let service: ChildProcess | null = null, firstPid: number | null = null, providerPid: number | null = null, restoredPid: number | null = null;
    let formerController: ChildProcess | undefined;
    let lifecycle: NativeRemoteIdleLifecycle | undefined;
    let first: ReturnType<typeof createRunnerdCodexTransport> | undefined, restored: ReturnType<typeof createRunnerdCodexTransport> | undefined;
    let checkpointCount = 0, releaseCount = 0;
    const observations: string[] = [];
    const checkpointRunner: CommandManagedRuntimeRunner = { execute: command => {
      if (!lifecycle) throw new Error("Idle lifecycle not published");
      return lifecycle.execute(command);
    } };
    const options = (directory: string) => ({
      runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
      sourceCodexHome: fixtureHome,
      codexArgs: ["--state-file-in-codex-home", "--call-log", join(caseRoot, "calls.log"),
        "--durable-turn-ids", "--require-existing-resume-state"],
      stateDirectory: directory, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 }, prpIdentity: identity,
    });
    try {
      service = spawn(process.execPath, ["-e", `
        const fs = require('node:fs'), http = require('node:http');
        const [portFile, sourceFile, token] = process.argv.slice(1);
        const server = http.createServer((req, res) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ pid: process.pid, token, source: fs.readFileSync(sourceFile, 'utf8') }));
        });
        server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, JSON.stringify({ port: server.address().port })));
      `, portFile, appFile, serviceToken], { cwd: caseRoot, detached: true, stdio: "ignore" });
      service.on("error", () => undefined);
      await waitUntil("HTTP listener", () => existsSync(portFile));
      const url = `http://127.0.0.1:${(await json(portFile)).port}/`;
      const servicePid = service.pid!;
      const serviceBirth = await readProcessStartedAt(servicePid);
      expect(serviceBirth).toBeTruthy();
      const checkService = async (label: string) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        expect(response.status).toBe(200);
        const body = await response.json() as { pid: number; token: string; source: string };
        expect(body).toMatchObject({ pid: servicePid, token: serviceToken });
        expect(await readProcessStartedAt(servicePid)).toBe(serviceBirth);
        observations.push(label);
        return body;
      };
      await checkService("before runner start");
      first = createRunnerdCodexTransport({ ...options(stateDirectory),
        readRunnerState: () => lifecycle ? lifecycle.readState() : json(runnerStateFile),
        controlPlaneRegistration: async authority => {
          await authority.start();
          return { connectUrl: authority.connectUrl,
            release: async () => { releaseCount += 1; },
            checkpoint: async settlement => {
              checkpointCount += 1;
              expect(releaseCount).toBe(1);
              expect(settlement).toBe("settled");
              expect(await lifecycle!.status()).toBe("closing");
              const state = await lifecycle!.readState();
              expect(state).toMatchObject({ ...identity, lifecycle: "suspended" });
              expect(alive(firstPid)).toBe(false);
              await checkService("during checkpoint");
              await syncRemoteRunnerDirectoryOut({ runner: checkpointRunner, sourcePath: stateDirectory, targetPath: backup, mode: 0o700 });
              const manifest = buildNativeHarnessBackupManifest({ backupRoot: backup, execution, runnerInstanceId: identity.runnerInstanceId,
                sourceProviderLeaseId: fixture.lease.providerLeaseId!, providerSessionIdentity: providerSessionIdentityFromDurableProviderState({
                  execution, providerState: await json(join(backup, "runner/codex-provider-state.json")),
                }) });
              const manifestPath = join(backup, "manifest.json");
              await writeFile(manifestPath, JSON.stringify(manifest));
              await lifecycle!.checkpoint(createNativeHarnessBackupStamp({ manifestPath, sessionScopeId: runId,
                authorizedProviderLeaseId: fixture.lease.providerLeaseId!, normalizedSessionId: identity.normalizedSessionId,
                runnerInstanceId: identity.runnerInstanceId, completedAt: manifest.completedAt }));
            },
          };
        },
      });
      const started = await first.transport.request("thread/start", { cwd: fixture.workspace.cwd, dynamicTools: [] });
      const providerSessionId = (started.thread as Record<string, unknown>).id;
      const turn = await first.transport.request("turn/start", { input: [{ type: "text", text: "Complete the app edit." }] });
      const firstTurnId = (turn.turn as Record<string, unknown>).id;
      let completed = false;
      const events = (async () => {
        for await (const notification of first!.transport.notifications()) {
          if (notification.method === "turn/completed") { completed = true; return; }
        }
      })();
      await waitUntil("completed provider turn", () => completed);
      await events;
      firstPid = first.evidence().runnerPid; providerPid = first.evidence().providerPid;
      expect(firstPid).toBeTruthy(); expect(alive(firstPid)).toBe(true);
      const startedAt = await readProcessStartedAt(firstPid!);
      if (!startedAt) throw new Error("Missing runner start fingerprint");
      const processOwner = { ...(fixture.lease.metadata!.runtimeServiceProcessOwner as Record<string, unknown>),
        process: { version: 1, pid: firstPid, processGroupId: firstPid, uid: process.getuid!(), bootId: randomUUID(), startTicks: "100" } };
      await db.update(environmentLeases).set({ metadata: { ...fixture.lease.metadata, runtimeServiceProcessOwner: processOwner } }).where(eq(environmentLeases.id, fixture.lease.id));
      await db.update(heartbeatRuns).set({ processPid: firstPid, processStartedAt: new Date(startedAt), runnerInstanceId: identity.runnerInstanceId,
        runnerProfileJson: { ...fixture.run.runnerProfileJson, nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
      let controller = await currentNativeControllerIdentity();
      if (outcome.includes("takeover")) {
        // Isolate the recorded host-process lifetime from the test's PRP
        // driver. This verifies transfer through checkpointing, not automatic
        // reconnection of a restarted production controller.
        formerController = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", caseRoot], { detached: true, stdio: "ignore" });
        const birth = await readProcessStartedAt(formerController.pid!);
        if (!birth) throw new Error("Missing fixture controller birth");
        controller = { bootId: randomUUID(), pid: formerController.pid!, processStartedAt: new Date(birth) };
      }
      await db.update(nativeRunFinalizations).set({ controllerBootId: controller.bootId, controllerPid: controller.pid,
        controllerProcessStartedAt: controller.processStartedAt }).where(eq(nativeRunFinalizations.runId, runId));
      const proof = await withNativeRemoteWarmRetention(db, { execution, environmentLeaseId: fixture.lease.id, runnerInstanceId: identity.runnerInstanceId,
        runnerIdentity: identity, sessionConfigDigest: "sha256:" + "c".repeat(64), leaseOwner: fixture.claim.leaseOwner,
        attempt: 0, controllerGeneration: 1, controller }, async (tx, retention) => {
        await tx.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, phase: "committed" }).where(eq(nativeRunFinalizations.runId, runId));
        return retention;
      });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      await environmentService(db).releaseLease(fixture.lease.id, "retained", { cleanupStatus: "success" });
      const methods = ["environmentRunProcessControl", "environmentRunnerRecovery", "environmentRunnerRecoveryExecute"];
      const provider = vi.fn(async (pluginId: string, method: string, params: Record<string, unknown>) => {
        expect(pluginId).toBe(fixture.pluginId);
        expect(params).toMatchObject({ owner: proof.process.remoteProcessIdentity, workspaceConnection: proof.process.workspaceConnection });
        expect(params).not.toHaveProperty("expectedIdleCloseNonce");
        if (method === "environmentRunProcessControl") {
          expect(params.operation).toEqual({ action: "inspect" });
          return { state: alive(firstPid) ? "running" : "exited", workspaceConnection: proof.process.workspaceConnection };
        }
        if (method === "environmentRunnerRecovery") {
          expect(params.operation).toBe("read_state");
          return { state: "ready", workspaceConnection: proof.process.workspaceConnection, runnerState: await json(runnerStateFile) };
        }
        expect(method).toBe("environmentRunnerRecoveryExecute");
        const command = (params as unknown as PluginEnvironmentRunnerRecoveryExecuteParams).execution;
        // A real command transport for the fixture filesystem; only inject an
        // archive failure in the negative case, after actual PRP suspension.
        let result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
        if (outcome.includes("archive_failure") && command.args?.some(arg => arg.includes("tar "))) {
          result = { stdout: "", stderr: "fixture archive failure", exitCode: 1, timedOut: false };
        } else {
          const child = execFile(command.command, command.args ?? [], { cwd: caseRoot, timeout: command.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
          child.stdin?.end(command.stdin);
          result = await new Promise((resolveResult, reject) => {
            let stdout = "", stderr = "";
            child.stdout?.on("data", data => { stdout += data; }); child.stderr?.on("data", data => { stderr += data; });
            child.on("error", reject);
            child.on("close", code => resolveResult({ stdout, stderr, exitCode: code ?? -1, timedOut: false }));
          });
        }
        return { state: "executed", workspaceConnection: proof.process.workspaceConnection, result };
      });
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
        isRunning: () => true, getWorker: () => ({ supportedMethods: methods }), call: provider,
      } as unknown as PluginWorkerManager });
      let idleProof = proof;
      if (formerController) {
        const binding = { companyId, runId, expectedProcess: proof.process, expectedRetention: nativeRemoteRetentionAuthority(proof)! };
        expect(await runtime.claimIdleRunnerController(binding)).toBeNull(); expect(provider).not.toHaveBeenCalled();
        await stopOwned(formerController.pid!, caseRoot);
        const claimed = await runtime.claimIdleRunnerController(binding);
        expect(claimed?.controllerTakeover?.generation).toBe(1);
        idleProof = claimed!;
        expect(await runtime.controlRunProcess({ companyId, runId, environmentLeaseId: fixture.lease.id,
          expectedRetention: binding.expectedRetention, expectedOwner: proof.process.remoteProcessIdentity,
          operation: { action: "signal", signal: "SIGTERM" } })).toEqual({ state: "unverified" });
        expect(alive(firstPid)).toBe(true); await checkService("after idle controller transfer");
      }
      lifecycle = await createNativeRemoteIdleLifecycle({ db, runtime, retention: idleProof });
      expect(await lifecycle.controls.inspect(proof.process.remoteProcessIdentity)).toBe("running");
      await expect(lifecycle.execute({ command: "sh", args: ["-c", "exit 99"] })).rejects.toThrow("idle_authority_unverified");
      await checkService("after run completion");
      const close = lifecycle.close(() => first!.transport.close());
      if (outcome.includes("archive_failure")) {
        await expect(close).rejects.toThrow("runner_remote_checkpoint_failed");
        expect(await lifecycle.status()).toBe("closing");
        await expect(withRuntimeServiceLeaseLock(db, fixture.lease, tx => assertNoNativeRunnerClosing(tx, fixture.lease))).rejects.toThrow("idle_close_pending");
        expect(existsSync(backup)).toBe(false);
      } else {
        expect(await close).toBe(true);
        expect(await lifecycle.status()).toBe("closed");
        const [closedLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, fixture.lease.id));
        expect(closedLease!.metadata?.nativeWarmRunnerClose).toMatchObject({ checkpoint: { version: 1,
          stamp: { normalizedSessionId: identity.normalizedSessionId, runnerInstanceId: identity.runnerInstanceId, sourceProviderLeaseId: fixture.lease.providerLeaseId } } });
        await expect(withRuntimeServiceLeaseLock(db, fixture.lease, tx => assertNoNativeRunnerClosing(tx, fixture.lease))).resolves.toBeUndefined();
        expect(await json(join(backup, "runner/runner-state.json"))).toMatchObject({ ...identity, lifecycle: "suspended" });
        expect(existsSync(join(backup, "codex-home/fake-codex-state.json"))).toBe(true);
        // Remove the original state, so continuation must consume the archive.
        await rm(stateDirectory, { recursive: true, force: true });
        restored = createRunnerdCodexTransport({ ...options(backup), resumeDynamicTools: [],
          prpIdentity: { ...identity, runId: randomUUID(), turnId: randomUUID(), itemId: randomUUID() } });
        const resumed = await restored.transport.request("thread/read", {});
        expect(resumed.thread).toMatchObject({ id: providerSessionId });
        const second = await restored.transport.request("turn/start", { input: [{ type: "text", text: "Continue the same app." }] });
        restoredPid = restored.evidence().runnerPid;
        expect(restoredPid).toBeTruthy(); expect(restoredPid).not.toBe(firstPid);
        expect((second.turn as Record<string, unknown>).id).not.toBe(firstTurnId);
        let secondCompleted = false;
        const secondEvents = (async () => {
          for await (const notification of restored!.transport.notifications()) {
            if (notification.method === "turn/completed") { secondCompleted = true; return; }
          }
        })();
        await waitUntil("continued provider turn completion", () => secondCompleted);
        await secondEvents;
        const calls = await readFile(join(caseRoot, "calls.log"), "utf8");
        expect(calls.match(/^thread\/start$/gm)).toHaveLength(1);
        expect(calls).toContain("thread/resume\n");
        expect(calls.match(/^turn\/start$/gm)).toHaveLength(2);
        await writeFile(appFile, "export default () => 'continued app';\n");
        expect((await checkService("after checkpoint continuation")).source).toContain("continued app");
        await restored.transport.close();
        expect(alive(restoredPid)).toBe(false);
        await checkService("after continued runner shutdown");
      }
      expect(checkpointCount).toBe(1); expect(releaseCount).toBe(1);
      expect(alive(firstPid)).toBe(false);
      await waitUntil("original provider exit", () => !alive(providerPid));
      await expect(lifecycle.execute({ command: "sh", args: ["-c", "exit 99"] })).rejects.toThrow("idle_authority_unverified");
      await checkService("after idle shutdown");
      expect(observations).toContain("during checkpoint");
    } finally {
      restoredPid ??= restored?.evidence().runnerPid ?? null;
      firstPid ??= first?.evidence().runnerPid ?? null;
      providerPid ??= first?.evidence().providerPid ?? null;
      await restored?.transport.close().catch(() => undefined);
      await first?.transport.close().catch(() => undefined);
      await stopOwned(restoredPid, backup);
      await stopOwned(firstPid, caseRoot);
      await stopOwned(service?.pid ?? null, caseRoot);
      await stopOwned(formerController?.pid ?? null, caseRoot);
      if (providerPid) await waitUntil("provider cleanup", () => !alive(providerPid));
    }
  }, 45_000);
});

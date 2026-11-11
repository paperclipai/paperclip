import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations } from "@paperclipai/db";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { beforeAll, expect, vi } from "vitest";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary, DurablePrpControlPlane, readRunnerdArtifactBinding,
  type RunnerProcessHandle } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, fakeCodexAppServer, nativeRestartFixture, processAlive, realProcessIt,
  remotePreparedWorkspace, stopOwnedProcessGroup, waitForCondition } from "../../__tests__/helpers/native-restart.js";
import { registerRunnerPrpAuthority } from "../../realtime/runner-prp-ws.js";
import { currentControllerProcess } from "../controller-process-identity.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { loadNativeRunnerCheckpoint, nativeRunnerCheckpointRegistration, readNativePreparationPublication, restoreNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { readNativePreparationHandoffReadiness } from "./native-preparation-handoff.js";
import { recordNativeRemoteRunnerLaunchIntent, readNativeRemoteRunnerLaunchIntent } from "./native-runner-launch-intent.js";
import { claimNativeRestartRecoveries } from "./native-restart-recovery.js";
import { launchNativeRemoteRunnerOnce, NATIVE_REMOTE_LAUNCH_SCRIPT, readNativeRemoteLaunchReceipt } from "./native-remote-launch-handoff.js";

const executeFile = promisify(execFile);

describeEmbeddedPostgres("classic remote launch checkpoint cutover", () => {
  const environment = nativeRestartFixture();
  let shared: typeof environment.current;
  beforeAll(() => { shared = environment.current; });

  realProcessIt("preserves the launching PG proof and adopts one physical Runner after pre-receipt lost ACK", async () => {
    const f = await environment.seedRun("CLASSIC-PRE-RECEIPT");
    const oldRoot = join(shared.runtimeRoot, f.runId + "-old-controller");
    const newRoot = join(shared.runtimeRoot, f.runId + "-new-controller");
    const finalRoot = join(shared.runtimeRoot, f.runId + "-final-controller");
    const sandbox = join(shared.runtimeRoot, f.runId + "-sandbox");
    await mkdir(join(sandbox, "filesystem/codex-home"), { recursive: true });
    const remote = { ...remotePreparedWorkspace(), remoteCwd: sandbox };
    const identity = { ...environment.transportOptions(f, oldRoot).prpIdentity, environmentLeaseId: remote.workspaceId };
    const binding = { companyId: shared.companyId, issueId: f.issueId, runId: f.runId };
    const bootId = randomUUID(), leaseOwner = bootId + ":launching", host = await currentControllerProcess();
    await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.preparedProfile,
      nativePreparationHandoffVersion: 1, nativePreparationFencingVersion: 1, nativeWorkspaceSync: remote } })
      .where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(nativeRunFinalizations).set({ attempt: 1, controllerBootId: bootId, controllerGeneration: 1,
      controllerPid: 2_000_000_001, controllerHostHash: host.hostHash, controllerProcessStartedAt: new Date(Date.now() - 60_000),
      leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    await f.db.insert(environmentLeases).values({ id: remote.leaseId, companyId: shared.companyId, issueId: f.issueId,
      heartbeatRunId: f.runId, provider: "fixture", providerLeaseId: remote.providerLeaseId, leasePolicy: "retain_on_failure",
      metadata: { agentId: shared.agentId } });
    const stateDirectory = join(sandbox, ".paperclip-runtime/paperclip-runner/sessions",
      createHash("sha256").update(identity.normalizedSessionId).digest("hex"), "runner");
    const processIdentityPath = join(stateDirectory, "runner-process.identity");
    const diagnosticsDirectory = join(sandbox, "diagnostics");
    const script = NATIVE_REMOTE_LAUNCH_SCRIPT
      .replace('const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");',
        'const stat = String(pid) + " (fixture) " + ["S", ...Array(18).fill("0"), "1234"].join(" ");')
      .replace('const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();', 'const boot = "abcd-1234";')
      .replace('} else if (mode === "publish") {', '} else if (mode === "publish") {fs.writeFileSync(path.join(intent.remoteCwd,"owned-runner-pid"),encodedConfig);while(!fs.existsSync(path.join(intent.remoteCwd,"release-receipt")))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);')
      .replace('child.unref();', 'fs.appendFileSync(path.join(intent.remoteCwd,"spawned-runner-pids"),String(child.pid)+"\\n");child.unref();');
    const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async request => {
      expect(request.command).toBe("node");
      expect(request.cwd).toBe(sandbox);
      const args = request.args!.map(value => value === NATIVE_REMOTE_LAUNCH_SCRIPT ? script : value);
      try {
        const result = await executeFile(process.execPath, args, { cwd: sandbox, env: { ...process.env, ...request.env },
          timeout: request.timeoutMs, maxBuffer: 32_768 });
        return { exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: null, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const result = error as { code?: number; stdout?: string; stderr?: string };
        return { exitCode: typeof result.code === "number" ? result.code : 1, signal: null, timedOut: false,
          pid: null, startedAt: null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      }
    });
    const remoteRunner = { execute } satisfies CommandManagedRuntimeRunner;
    let accepted!: () => void;
    const launchAccepted = new Promise<void>(resolve => { accepted = resolve; });
    let lost = false;
    const oldRunner = { execute: vi.fn<CommandManagedRuntimeRunner["execute"]>(async request => {
      if (lost) throw new Error("old_controller_connection_closed");
      await execute(request);
      lost = true; accepted();
      throw new Error("remote_launch_ack_lost");
    }) };
    const stop = vi.fn(() => true), launchFailure: unknown[] = [];
    const runnerArtifact = readRunnerdArtifactBinding(defaultCapabilityRunnerdBinary());
    const options = { ...environment.transportOptions(f, oldRoot), prpIdentity: identity,
      runnerStateDirectory: stateDirectory, runnerFilesystemRoot: join(sandbox, "filesystem"),
      codexCommand: fakeCodexAppServer, codexArgs: ["--state-file", join(sandbox, "provider.json"),
        "--call-log", join(sandbox, "calls.log"), "--linger-after-turn-start", "--held-output"],
      runnerArtifact,
      controlPlaneCheckpointRegistration: nativeRunnerCheckpointRegistration({ db: f.db, binding, bootId }),
      controlPlaneRegistration: (authority: Parameters<typeof registerRunnerPrpAuthority>[0]["authority"]) =>
        registerRunnerPrpAuthority({ ...binding, authority }),
    };
    const first = createRunnerdCodexTransport({ ...options, runnerProcessLauncher: spec => {
      const start = async () => {
        const intent = await recordNativeRemoteRunnerLaunchIntent(f.db, { ...binding, bootId,
          environmentLeaseId: remote.leaseId, providerLeaseId: remote.providerLeaseId,
          remoteCwd: sandbox, remoteBinary: spec.command, processIdentityPath, stateDirectory, diagnosticsDirectory, spec });
        if (!intent) throw new Error("canonical_remote_launch_intent_missing");
        await launchNativeRemoteRunnerOnce({ runner: oldRunner, intent, spec, deadline: Date.now() + 2_000 });
      };
      void start().catch(error => { launchFailure.push(error); });
      return { child: { exitCode: null, signalCode: null, kill: stop },
        completion: new Promise<Awaited<RunnerProcessHandle["completion"]>>(() => {}), processGroupId: null } satisfies RunnerProcessHandle;
    } });
    const initial = first.transport.request("thread/start", { cwd: sandbox, dynamicTools: [] }).catch(error => error);
    let adopted: ReturnType<typeof createRunnerdCodexTransport> | undefined;
    let intermediate: InstanceType<typeof DurablePrpControlPlane> | undefined;
    let runnerPid: number | null = null;
    try {
      await Promise.race([launchAccepted, new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("remote_launch_was_not_accepted")), 10_000).unref())]);
      await waitForCondition("old controller launch receipt remains unresolved", async () => launchFailure.length === 1);
      expect(launchFailure).toEqual([expect.objectContaining({ code: "native_remote_launch_receipt_pending" })]);
      expect(existsSync(processIdentityPath)).toBe(false);
      expect(await readNativePreparationHandoffReadiness(f.db, { ...binding, controllerBootId: bootId }))
        .toMatchObject({ kind: "launching", runnerInstanceId: identity.runnerInstanceId, environmentLeaseId: remote.leaseId });
      const saved = await readNativeRemoteRunnerLaunchIntent(f.db, binding);
      expect(saved).not.toBeNull();
      await first.detachControllerForRestart();
      await f.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
      const [claim] = await claimNativeRestartRecoveries({ db: f.db, controller: shared.successor, restartKind: "hard", runIds: [f.runId] });
      expect(claim).toMatchObject({ kind: "reattach_remote_runner", runId: f.runId, controllerGeneration: 2 });
      await rm(oldRoot, { recursive: true, force: true });
      const firstCheckpoint = await restoreNativeRunnerCheckpoint(f.db, binding, newRoot);
      expect(firstCheckpoint).not.toBeNull();
      const secondOwner = await readNativeRemoteRunnerLaunchIntent(f.db, binding);
      expect(secondOwner).toMatchObject({ bootId: shared.successor.bootId, generation: 2, intent: saved!.intent,
        bootstrapTicket: saved!.bootstrapTicket });
      expect(await readNativePreparationHandoffReadiness(f.db, { ...binding, controllerBootId: shared.successor.bootId }))
        .toMatchObject({ kind: "launching", runnerInstanceId: identity.runnerInstanceId });
      intermediate = new DurablePrpControlPlane({ stateDirectory: join(newRoot, "control-plane"), identity,
        expectedRunnerVersion: firstCheckpoint!.runnerVersion, expectedRunnerDigest: firstCheckpoint!.runnerDigest });
      await nativeRunnerCheckpointRegistration({ db: f.db, binding, bootId: shared.successor.bootId })(intermediate);
      await intermediate.renewPendingBootstrapTicket(saved!.bootstrapTicket);
      await intermediate.flushCheckpoint();
      const republished = await readNativePreparationPublication(f.db, binding);
      expect(republished?.kind).toBe("published");
      const republishedIntent = await readNativeRemoteRunnerLaunchIntent(f.db, binding);
      expect(republishedIntent!.intent).toEqual(saved!.intent);
      if (republished?.kind !== "published") throw new Error("republished_launching_checkpoint_missing");
      expect(republishedIntent!.publication).toEqual({ headerSha256: republished.publication.headerSha256,
        cursorSha256: republished.publication.cursorSha256, partsSha256: republished.publication.partsSha256 });
      expect(republished.publication.headerSha256).not.toBe(saved!.intent.checkpoint.headerSha256);
      expect(existsSync(processIdentityPath)).toBe(false);
      await intermediate.stop();
      intermediate = undefined;
      await f.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
      const finalOwner = { ...shared.successor, bootId: randomUUID() };
      const [secondClaim] = await claimNativeRestartRecoveries({ db: f.db, controller: finalOwner, restartKind: "hard", runIds: [f.runId] });
      expect(secondClaim).toMatchObject({ kind: "reattach_remote_runner", runId: f.runId, controllerGeneration: 3 });
      const finalIntent = await readNativeRemoteRunnerLaunchIntent(f.db, binding);
      expect(finalIntent).toMatchObject({ bootId: finalOwner.bootId, generation: 3, intent: saved!.intent,
        bootstrapTicket: saved!.bootstrapTicket });
      await rm(newRoot, { recursive: true, force: true });
      const checkpoint = await restoreNativeRunnerCheckpoint(f.db, binding, finalRoot);
      expect(checkpoint).not.toBeNull();
      writeFileSync(join(sandbox, "release-receipt"), "release");
      const receipt = await readNativeRemoteLaunchReceipt({ runner: remoteRunner, intent: saved!.intent, deadline: Date.now() + 5_000 });
      runnerPid = receipt.pid;
      const startedAt = await readProcessStartedAt(runnerPid);
      const duplicate = vi.fn(() => { throw new Error("duplicate_runner_spawn"); });
      adopted = createRunnerdCodexTransport({ ...options, stateDirectory: finalRoot,
        controlPlaneCheckpointRegistration: nativeRunnerCheckpointRegistration({ db: f.db, binding, bootId: finalOwner.bootId }),
        runnerBinary: join(finalRoot, "must-not-launch-another-runner"),
        runnerArtifact: { version: checkpoint!.runnerVersion, digest: checkpoint!.runnerDigest },
        pendingBootstrapTicket: saved!.bootstrapTicket, runnerProcessLauncher: duplicate,
        adoptExistingRunner: { pid: receipt.pid, processGroupId: null, startedAt: receipt.startedAt,
          isAlive: () => processAlive(receipt.pid) } });
      const opened = await adopted.transport.request("thread/start", { cwd: sandbox, dynamicTools: [] });
      expect(opened.thread).toEqual(expect.objectContaining({ id: expect.any(String) }));
      await adopted.transport.request("turn/start", { input: [{ type: "text", text: "Continue the original launched run." }] });
      await waitForCondition("one provider turn", async () => (await readFile(join(sandbox, "calls.log"), "utf8")).includes("turn/start"));
      expect(adopted.evidence().runnerPid).toBe(receipt.pid);
      expect(adopted.evidence().providerPid).toEqual(expect.any(Number));
      expect(await readProcessStartedAt(receipt.pid)).toBe(startedAt);
      expect(readFileSync(join(sandbox, "spawned-runner-pids"), "utf8").trim().split("\n")).toEqual([String(receipt.pid)]);
      expect((await readFile(join(sandbox, "calls.log"), "utf8")).match(/^turn\/start$/gm)).toHaveLength(1);
      expect(execute.mock.calls.filter(([request]) => request.args?.[2] === "launch")).toHaveLength(1);
      expect(duplicate).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(saved!.intent.nonce).toBe(receipt.nonce);
      const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run!.runnerInstanceId).toBe(identity.runnerInstanceId);
      expect(run!.nativeSessionId).toBe(identity.normalizedSessionId);
      expect(launchFailure).toEqual([expect.objectContaining({ code: "native_remote_launch_receipt_pending" })]);
      const finalCheckpoint = await loadNativeRunnerCheckpoint(f.db, binding);
      const finalState = JSON.parse(finalCheckpoint!.records.get("header")!).state;
      expect(finalState.identity).toEqual(identity);
      expect(finalState.bootstrapHistory.credentialsIssued).toBe(1);
    } finally {
      await intermediate?.stop();
      writeFileSync(join(sandbox, "release-receipt"), "release");
      await adopted?.transport.close().catch(() => undefined);
      await first.transport.close().catch(() => undefined);
      if (!runnerPid && existsSync(join(sandbox, "owned-runner-pid"))) runnerPid = Number(readFileSync(join(sandbox, "owned-runner-pid"), "utf8"));
      await stopOwnedProcessGroup(runnerPid, sandbox).catch(() => undefined);
      await initial;
    }
  }, 45_000);
});

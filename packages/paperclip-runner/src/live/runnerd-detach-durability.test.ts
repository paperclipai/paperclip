import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary, readRunnerdArtifactBinding, runnerdRecoveryInternals } from "./runnerd-codex-transport.js";

it.each(["resolved", "rejected"] as const)("keeps the checkpoint behind controller retirement (%s)", async outcome => {
  const steps: string[] = [];
  let release!: () => void;
  let reject!: (error: Error) => void;
  const barrier = new Promise<void>((resolveDrain, rejectDrain) => { release = resolveDrain; reject = rejectDrain; });
  const operation = runnerdRecoveryInternals.releaseRunnerProcessOwnership({
    runnerSettled: true,
    release: () => { steps.push("route"); },
    retireController: async () => { steps.push("drain"); await barrier; },
    checkpoint: () => { steps.push("checkpoint"); },
    forceKill: () => { steps.push("containment"); },
  });
  await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
  expect(steps).toEqual(["route", "drain"]);
  if (outcome === "rejected") {
    const failed = expect(operation).rejects.toThrow("journal unavailable");
    reject(new Error("journal unavailable"));
    await failed;
    expect(steps).toEqual(["route", "drain", "containment"]);
  } else {
    release();
    await operation;
    expect(steps).toEqual(["route", "drain", "checkpoint", "containment"]);
  }
});

it.each(["drain", "timeout", "external_close"] as const)("joins an output flush before controller retirement permits a successor writer (%s)", async mode => {
  const root = await fs.mkdtemp(join(tmpdir(), "runnerd-detach-write-"));
  await fs.mkdir(join(root, "diagnostics"), { mode: 0o700 });
  const binary = defaultCapabilityRunnerdBinary();
  const artifact = readRunnerdArtifactBinding(binary);
  let core!: DurablePrpControlPlane;
  const start = DurablePrpControlPlane.prototype.start;
  const startSpy = vi.spyOn(DurablePrpControlPlane.prototype, "start").mockImplementation(function (port) {
    core = this;
    return start.call(this, port);
  });
  let release!: () => void;
  const barrier = new Promise<void>(resolveWrite => { release = resolveWrite; });
  let staged = false;
  const originalOpen = fs.open;
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await originalOpen(...args);
    if (!staged && String(args[0]).includes(".control-plane-state.json.")) {
      const sync = file.sync.bind(file);
      file.sync = async () => { staged = true; await barrier; await sync(); };
    }
    return file;
  });
  let child: ChildProcess | undefined;
  let exit: Promise<void> | undefined;
  const closeSteps: string[] = [];
  let stopSpy: ReturnType<typeof vi.spyOn> | undefined;
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: binary,
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "provider-state.json"), "--split-event-burst", "--split-event-prefix-count", "1"],
    stateDirectory: root,
    closeGraceMs: mode === "timeout" ? 200 : 1_500,
    ...(mode === "external_close" ? { controlPlaneRegistration: async (authority: DurablePrpControlPlane) => {
      await authority.start();
      const stop = authority.stop.bind(authority);
      stopSpy = vi.spyOn(authority, "stop").mockImplementation(async () => {
        closeSteps.push("stop");
        release();
        await stop();
      });
      return { connectUrl: authority.connectUrl, release: () => { closeSteps.push("release"); } };
    } } : {}),
    runnerProcessLauncher: spec => {
      child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.environment, stdio: ["ignore", "pipe", "pipe"] });
      const owned = child;
      let stderr = "";
      owned.stderr?.on("data", chunk => { stderr += String(chunk); });
      exit = new Promise(resolveExit => owned.once("exit", () => resolveExit()));
      const completion = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolveExit, reject) => {
        owned.once("error", reject);
        owned.once("exit", (code, signal) => resolveExit({ code, signal, stdout: "", stderr }));
      });
      return { child: owned, completion };
    },
  });
  bundle.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
  let detached: Promise<void> | undefined;
  try {
    await bundle.transport.request("thread/start", { cwd: root, dynamicTools: [{
      name: "get_task_context", description: "Read fixture context.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }] });
    await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Exercise a held output flush." }] });
    await vi.waitFor(() => expect(staged).toBe(true), { timeout: 5_000 });
    if (mode === "external_close") {
      await bundle.transport.close().catch(error => {
        expect(error.message).toMatch(/journal drain timed out|did not durably suspend/);
      });
      expect(closeSteps.indexOf("release")).toBeGreaterThanOrEqual(0);
      expect(closeSteps.indexOf("release")).toBeLessThan(closeSteps.indexOf("stop"));
      return;
    }
    let settled = false;
    detached = bundle.detachControllerForRestart().then(() => { settled = true; });
    await vi.waitFor(() => expect(core.activeRunnerConnectionCount()).toBe(0));
    await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
    expect(settled).toBe(false);
    if (mode === "timeout") {
      await expect(detached).rejects.toThrow("journal drain timed out");
      await expect(bundle.detachControllerForRestart()).rejects.toThrow("journal drain timed out");
      await expect(bundle.transport.close()).rejects.toThrow("journal drain timed out");
      release();
      await core.drainPendingConnectionProcessing();
    } else {
      release();
      await detached;
    }
    const successor = new DurablePrpControlPlane({ stateDirectory: join(root, "control-plane"),
      identity: core.store.state.identity, expectedRunnerVersion: artifact.version, expectedRunnerDigest: artifact.digest });
    successor.queueCommand("session.snapshot", {}, "successor_command");
    await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
    const persisted = JSON.parse(await fs.readFile(successor.store.path, "utf8"));
    expect(persisted.commands.some((command: { commandId: string }) => command.commandId === "successor_command")).toBe(true);
  } catch (error) {
    const diagnostic = await fs.readFile(join(root, "diagnostics", "runnerd.stderr.log"), "utf8").catch(() => "");
    throw new Error(`${String(error)}\n${diagnostic}`, { cause: error });
  } finally {
    release();
    await detached?.catch(() => undefined);
    openSpy.mockRestore();
    startSpy.mockRestore();
    await bundle.detachControllerForRestart().catch(() => undefined);
    const providerPid = bundle.evidence().codexPid;
    if (providerPid) {
      try { process.kill(providerPid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    child?.kill("SIGKILL");
    await exit;
    await core?.drainPendingConnectionProcessing();
    stopSpy?.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 15_000);

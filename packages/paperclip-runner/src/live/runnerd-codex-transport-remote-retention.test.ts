import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { NativeSessionCloseUnrecoverableError } from "../contracts/native-session-backend.js";
import type * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { codexSemanticToolSpecs } from "../drivers/codex/codex-app-server-driver.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, expectTurnStarted, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

function processState(pid: number): "alive" | "gone" {
  try { process.kill(pid, 0); } catch { return "gone"; }
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z") ? "gone" : "alive";
  } catch { return "gone"; }
}

const signal = (pid: number | null | undefined, name: NodeJS.Signals) => {
  if (!pid) return;
  try { process.kill(pid, name); } catch (error) { if (!["ESRCH", "EPERM"].includes(String((error as NodeJS.ErrnoException).code))) throw error; }
};

async function unreachableRemoteRunnerClose(input: {
  retainUnsettledRemoteRunner?: boolean;
  recoveryPurpose?: "execution" | "stop_cleanup";
}) {
  const directory = await mkdtemp(join(tmpdir(), "runnerd-remote-retention-"));
  const children: ReturnType<typeof spawn>[] = [];
  const launch = vi.fn((spec: durableControlPlane.RunnerProcessLaunchSpec) => {
    const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.environment, stdio: "ignore" });
    children.push(child);
    return {
      child,
      completion: new Promise<durableControlPlane.RunnerProcessResult>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal, stdout: "", stderr: "" }));
      }),
      isExitConfirmed: () => child.exitCode !== null || child.signalCode !== null,
    };
  });
  const diagnostics: string[] = [];
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(directory, "--linger-after-turn-start"), stateDirectory: directory,
    runnerReconnectGraceMs: 60_000, runnerProcessLauncher: launch, closeGraceMs: 600,
    onDiagnostic: message => diagnostics.push(message),
    ...(input.recoveryPurpose ? { recoveryPurpose: input.recoveryPurpose } : {}),
  });
  bundle.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
  let providerPid: number | null = null;
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", { cwd: directory, dynamicTools: [] });
    await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Keep working." }] });
    await expectTurnStarted(bundle.transport.notifications()[Symbol.asyncIterator]());
    providerPid = bundle.evidence().codexPid;
    const runner = children[0]!;
    signal(runner.pid, "SIGSTOP");
    const closed = await bundle.transport.close("native session execution complete",
      input.retainUnsettledRemoteRunner === undefined ? undefined
        : { retainUnsettledRemoteRunner: input.retainUnsettledRemoteRunner })
      .then(() => null, (error: unknown) => error);
    const runnerState = processState(runner.pid!);
    signal(runner.pid, "SIGCONT");
    const runnerJournal = JSON.parse(await readFile(join(directory, "runner", "runner-state.json"), "utf8")) as Record<string, unknown>;
    return { closed, runnerState, runnerJournal, launch, diagnostics };
  } finally {
    for (const child of children) { signal(child.pid, "SIGCONT"); signal(child.pid, "SIGKILL"); }
    signal(providerPid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}

it("leaves an unreachable remote Runner alive and unsettled when a failed run closes, so the same-run reattach can adopt it", async () => {
  const result = await unreachableRemoteRunnerClose({ retainUnsettledRemoteRunner: true });
  expect(result.closed).toBeInstanceOf(NativeSessionCloseUnrecoverableError);
  expect(result.runnerState).toBe("alive");
  expect(result.runnerJournal.lifecycle).toBe("ready");
  expect(result.launch).toHaveBeenCalledTimes(1);
  const settlement = result.diagnostics.find(message => message.startsWith("native_session_settlement_incomplete "));
  expect(JSON.parse(settlement!.slice("native_session_settlement_incomplete ".length)))
    .toMatchObject({ runnerSuspended: false, runnerRetained: true });
}, 30_000);

it.each([
  { title: "an explicit cancellation", options: { retainUnsettledRemoteRunner: false } },
  { title: "a caller that does not ask to retain it", options: {} },
  { title: "a Stop cleanup", options: { retainUnsettledRemoteRunner: true, recoveryPurpose: "stop_cleanup" as const } },
])("still stops an unreachable remote Runner on $title", async ({ options }) => {
  const result = await unreachableRemoteRunnerClose(options);
  expect(result.closed).toBeInstanceOf(Error);
  expect(result.runnerState).toBe("gone");
}, 30_000);

it("keeps a retained remote Runner for the reattaching controller, which settles it into a journal the next attempt can relaunch", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-remote-retention-adopt-"));
  const server = createServer();
  let authority: DurablePrpControlPlane | null = null;
  server.on("upgrade", (request, socket, head) => {
    if (!authority) { socket.destroy(); return; }
    authority.handleUpgrade(request, socket, "/runner", head);
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing retention test listener");
  const registration = async (next: DurablePrpControlPlane) => {
    authority = next;
    return { connectUrl: `ws://127.0.0.1:${address.port}/runner`, release: () => { if (authority === next) authority = null; } };
  };
  const children: ReturnType<typeof spawn>[] = [];
  const launch = vi.fn((spec: durableControlPlane.RunnerProcessLaunchSpec) => {
    const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.environment, stdio: "ignore", detached: true });
    children.push(child);
    return {
      child,
      completion: new Promise<durableControlPlane.RunnerProcessResult>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal, stdout: "", stderr: "" }));
      }),
      isExitConfirmed: () => child.exitCode !== null || child.signalCode !== null,
    };
  });
  const shared = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "provider-state.json"), "--hold-first-durable-turn"],
    stateDirectory: root,
    prpIdentity: {
      runnerInstanceId: "runner-retained", environmentLeaseId: "lease-retained", runId: "run-retained",
      normalizedSessionId: "session-retained", turnId: "turn-retained", itemId: "item-retained",
    },
    runnerReconnectGraceMs: 5_000,
    runnerProcessReconnectGraceMs: null,
    controlPlaneRegistration: registration,
  };
  const first = createCapabilityRunnerdCodexTransport({ ...shared, runnerProcessLauncher: launch, closeGraceMs: 600 });
  let adopted: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  let pid: number | null = null;
  let providerPid: number | null = null;
  try {
    const opened = await first.transport.request("thread/start", { cwd: root, dynamicTools: codexSemanticToolSpecs() });
    await first.transport.request("turn/start", { input: [{ type: "text", text: "Keep this task active." }] });
    for await (const notification of first.transport.notifications()) {
      if (notification.method === "turn/started") break;
    }
    pid = children[0]!.pid!;
    providerPid = first.evidence().codexPid;
    signal(pid, "SIGSTOP");
    await expect(first.transport.close("native session execution complete", { retainUnsettledRemoteRunner: true }))
      .rejects.toBeInstanceOf(NativeSessionCloseUnrecoverableError);
    expect(processState(pid)).toBe("alive");
    signal(pid, "SIGCONT");
    const journal = async () => JSON.parse(await readFile(join(root, "runner", "runner-state.json"), "utf8")) as Record<string, unknown>;
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
    expect(processState(pid)).toBe("alive");
    expect((await journal()).lifecycle).toBe("ready");
    const duplicateLaunch = vi.fn(() => { throw new Error("Must adopt the existing runner"); });
    const thread = opened.thread as Record<string, unknown>;
    const adoptedPid = pid;
    adopted = createCapabilityRunnerdCodexTransport({
      ...shared,
      resumeDynamicTools: codexSemanticToolSpecs(),
      resumeProviderSession: { driverSessionId: String(thread.id), providerSessionId: String(thread.sessionId) },
      runnerProcessLauncher: duplicateLaunch,
      adoptExistingRunner: {
        pid: adoptedPid, processGroupId: adoptedPid, startedAt: new Date().toISOString(),
        isAlive: () => processState(adoptedPid) === "alive",
        signal: name => { try { process.kill(-adoptedPid, name); return true; } catch { return false; } },
      },
    });
    adopted.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
    await adopted.transport.request("thread/read", {}).catch(() => undefined);
    await vi.waitFor(() => expect(processState(adoptedPid)).toBe("gone"), { timeout: 10_000, interval: 50 });
    expect(await journal()).toMatchObject({ lifecycle: "suspended", outbox: [], pendingTerminalDelivery: null });
    expect(duplicateLaunch).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    await adopted?.transport.close().catch(() => undefined);
    for (const child of children) { signal(child.pid, "SIGCONT"); signal(child.pid ? -child.pid : null, "SIGKILL"); }
    signal(providerPid, "SIGKILL");
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

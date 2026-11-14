import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { NativeExecutionInputV1 } from "../contracts/native-execution.js";
import type { PersistedNativeSession } from "../contracts/native-session-backend.js";
import type * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import type { executeNativeSession } from "../native-session-runtime.js";
import type { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

type ControlPlaneModule = typeof import("../control-plane/durable-prp-control-plane.js");
type Transport = ReturnType<typeof createCapabilityRunnerdCodexTransport>;

function alive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch { return false; }
}

const kill = (pid: number | null | undefined) => {
  if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch (error) { if (!["ESRCH", "EPERM"].includes(String((error as NodeJS.ErrnoException).code))) throw error; }
};

async function freshExecutorProcess() {
  vi.resetModules();
  const [backend, control, runtime, transport] = await Promise.all([
    import("../backends/codex-native-backend.js"),
    import("../control-plane/durable-prp-control-plane.js"),
    import("../native-session-runtime.js"),
    import("./runnerd-codex-transport.js"),
  ]);
  return {
    createBackend: backend.createRunnerdNativeSessionBackend,
    control,
    execute: runtime.executeNativeSession,
    createTransport: transport.createCapabilityRunnerdCodexTransport,
  };
}

function withUnreachableRemoteRunner(control: ControlPlaneModule) {
  let unreachable = true;
  const OriginalCore = control.DurablePrpControlPlane;
  const spy = vi.spyOn(control, "DurablePrpControlPlane")
    .mockImplementation(function(options: ConstructorParameters<typeof OriginalCore>[0]) {
      const core = new OriginalCore(options);
      const queueCommand = core.queueCommand.bind(core);
      core.queueCommand = ((type: string, ...rest: unknown[]) => {
        if (unreachable && type === "session.snapshot") throw new Error("runner snapshot unavailable");
        if (unreachable && (type === "runner.suspend" || type === "turn.stop")) return undefined;
        return (queueCommand as (...args: unknown[]) => unknown)(type, ...rest);
      }) as typeof core.queueCommand;
      return core;
    } as unknown as typeof OriginalCore);
  return { restore: () => { unreachable = false; spy.mockRestore(); } };
}

async function abandonTurnStart(label: string, providerArgs: string[]) {
  const root = await mkdtemp(join(tmpdir(), `runnerd-abandoned-${label}-`));
  const gate = join(root, "turn-started-gate");
  const callLog = join(root, "calls.log");
  const identity = { runId: `run-${label}`, sessionId: `session-${label}`, companyId: `company-${label}`,
    issueId: `issue-${label}`, agentId: `agent-${label}` };
  const execution: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: { runId: identity.runId, companyId: identity.companyId, issueId: identity.issueId, agentId: identity.agentId,
      executionWorkspaceId: `workspace-${label}` },
    session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    task: { identifier: "TEST-21", title: "Finish checks", description: null, prompt: "Finish the checks.", workMode: "standard" },
    workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
    provider: { kind: "codex", model: null },
    completionContract: { id: `contract-${label}`, sha256: "digest", schemaVersion: "paperclip.completion-contract.v1", contract: {
      revision: "1", objective: "Finish checks", criteria: [{ id: "checks", requirement: "Check the outcome" }],
    } },
    interactionResponses: [], credentialBindings: [],
  };
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
  const server = createServer();
  let authority: durableControlPlane.DurablePrpControlPlane | null = null;
  server.on("upgrade", (request, socket, head) => {
    if (!authority) { socket.destroy(); return; }
    authority.handleUpgrade(request, socket, "/runner", head);
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a control-plane listener");
  const options = {
    controlPlaneRegistration: async (next: durableControlPlane.DurablePrpControlPlane) => {
      authority = next;
      return { connectUrl: `ws://127.0.0.1:${address.port}/runner`, release: async () => { if (authority === next) authority = null; } };
    },
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(root, "--turn-started-gate", gate, "--call-log", callLog, ...providerArgs),
    stateDirectory: root, runnerReconnectGraceMs: 60_000, closeGraceMs: 600, turnStartTimeoutMs: 2_000,
    prpIdentity: { runnerInstanceId: `runner-${label}`, environmentLeaseId: `lease-${label}`, runId: identity.runId,
      normalizedSessionId: identity.sessionId, turnId: `turn-${label}`, itemId: `item-${label}` },
  };
  const events: PrpEvent[] = [];
  let checkpoint: PersistedNativeSession | null = null;
  const controlPlane: Parameters<typeof executeNativeSession>[0]["controlPlane"] = {
    async openRun() {},
    async checkpointSession(snapshot) { checkpoint = structuredClone(snapshot); },
    async appendEvent(event) {
      if (!("sourceSeq" in event)) throw new Error("Expected a durable PRP event");
      events.push(event);
      return { cursor: events.length, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" };
    },
    async replayEvents(request) {
      const source = events.filter(event => event.sourceInstanceId === request.sourceInstanceId);
      return { events: source.filter(event => event.sourceSeq > request.afterSourceSeq),
        highestContiguousSourceSeq: source.at(-1)?.sourceSeq ?? 0 };
    },
    async completeRun() {},
  };
  const transports: Transport[] = [];
  const cleanup = async () => {
    await rm(gate, { force: true });
    for (const bundle of [...transports].reverse()) await bundle.transport.close().catch(() => undefined);
    for (const child of children) kill(child.pid);
    for (const bundle of transports) { kill(bundle.evidence().runnerPid); kill(bundle.evidence().providerPid); }
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  };
  try {
    const firstProcess = await freshExecutorProcess();
    const remote = withUnreachableRemoteRunner(firstProcess.control);
    try {
      const first = firstProcess.createTransport({ ...options, runnerProcessLauncher: launch });
      transports.push(first);
      await expect(firstProcess.execute({
        input: execution, runnerInstanceId: options.prpIdentity.runnerInstanceId, controlPlaneInstanceId: `controller-${label}`,
        backend: firstProcess.createBackend(execution, { runnerInstanceId: options.prpIdentity.runnerInstanceId, transportFactory: () => first.transport }),
        timeoutMs: 30_000, requireSessionCloseBeforeReturn: true, controlPlane,
      })).rejects.toThrow("runnerd did not report the provider turn identity");
    } finally {
      remote.restore();
    }
    const runner = children[0]!;
    expect(alive(runner.pid)).toBe(true);
    const startedAt = transports[0]!.transport.processInfo!().startedAt;
    const saved = checkpoint as PersistedNativeSession | null;
    if (saved === null) throw new Error("Expected the first attempt to checkpoint its session");
    expect(saved.activeTurnId ?? null).toBeNull();
    const reattach = async () => {
      const secondProcess = await freshExecutorProcess();
      const duplicateLauncher = vi.fn(() => { throw new Error("duplicate runner spawn attempted"); });
      const adopted = secondProcess.createTransport({
        ...options,
        resumeDynamicTools: [],
        resumeActiveTurnId: saved.activeTurnId ?? null,
        resumeProviderSession: { driverSessionId: saved.sessionId, providerSessionId: saved.providerSessionId ?? null },
        runnerProcessLauncher: duplicateLauncher,
        adoptExistingRunner: {
          pid: runner.pid!, processGroupId: runner.pid!, startedAt, signal: () => true,
          isAlive: () => alive(runner.pid),
        },
      });
      transports.push(adopted);
      const backend = secondProcess.createBackend(execution, {
        runnerInstanceId: options.prpIdentity.runnerInstanceId, transportFactory: () => adopted.transport,
      });
      return {
        adopted, duplicateLauncher, backend,
        execute: (persistedSession: PersistedNativeSession) => secondProcess.execute({
          input: execution, persistedSession, resumeInterruptedTurn: true, runnerInstanceId: options.prpIdentity.runnerInstanceId,
          controlPlaneInstanceId: `controller-${label}-2`, timeoutMs: 30_000, controlPlane, backend,
        }),
      };
    };
    return { root, gate, callLog, runner, saved, events, reattach, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

it("finishes the run from the provider turn a timed-out turn.start left running once it completes after the reattachment", async () => {
  const attempt = await abandonTurnStart("completed-start", []);
  let release: ReturnType<typeof setInterval> | undefined;
  try {
    const second = await attempt.reattach();
    release = setInterval(() => {
      if (!second.adopted.evidence().diagnostics.some(line => line.includes("restored its durable PRP session"))) return;
      clearInterval(release);
      void writeFile(attempt.gate, "start");
    }, 20);
    release.unref();
    const completion = await second.execute(attempt.saved);
    expect(completion).toMatchObject({ turnId: "provider-turn-1", terminal: { runTerminalState: "succeeded" } });
    expect(second.duplicateLauncher).not.toHaveBeenCalled();
    expect(attempt.events.some(event => event.eventType === "session.failed")).toBe(false);
    const calls = (await readFile(attempt.callLog, "utf8")).trim().split(/\r?\n/);
    expect(calls.filter(call => call === "turn/start")).toHaveLength(1);
  } finally {
    clearInterval(release);
    await attempt.cleanup();
  }
}, 90_000);

it("binds output the abandoned provider turn reported while no controller was attached to the reattached run", async () => {
  const attempt = await abandonTurnStart("buffered-output", ["--hold-turn", "--held-final-message"]);
  try {
    await writeFile(attempt.gate, "start");
    await vi.waitFor(async () => {
      expect(await readFile(join(attempt.root, "runner", "codex-provider-state.json"), "utf8")).toContain("Durable Cloud final");
    }, { timeout: 15_000, interval: 50 });
    const second = await attempt.reattach();
    const recovery = await second.backend.recoverSession!(attempt.saved, { signal: new AbortController().signal });
    expect(recovery).toMatchObject({ recovered: true });
    const session = recovery.session!;
    const received: PrpEvent[] = [];
    const reading = (async () => { for await (const event of session.events()) received.push(event); })().catch(() => undefined);
    await vi.waitFor(() => {
      expect(received.find(event => event.eventType === "session.failed")).toBeUndefined();
      expect(received.some(event => event.eventType === "item.completed" && event.turnId === "provider-turn-1"
        && JSON.stringify(event.payload).includes("Durable Cloud final"))).toBe(true);
    }, { timeout: 15_000, interval: 50 });
    expect((await session.snapshot()).activeTurnId).toBe("provider-turn-1");
    expect(alive(attempt.runner.pid)).toBe(true);
    expect(second.duplicateLauncher).not.toHaveBeenCalled();
    await session.close({ reason: "test complete" }).catch(() => undefined);
    await reading;
  } finally {
    await attempt.cleanup();
  }
}, 90_000);

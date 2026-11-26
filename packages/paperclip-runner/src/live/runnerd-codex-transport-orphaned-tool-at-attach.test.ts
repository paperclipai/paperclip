import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { recoverToolCallback, TOOL_CALLBACK_INTERRUPTED_CODE } from "../control-plane/orphaned-tool-callback.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

const taskTool = { name: "get_task_context", description: "Read current task", inputSchema: { type: "object", properties: {}, additionalProperties: false } };

type SavedCommand = { commandId: string; type: string; status: string; payload: Record<string, unknown> };

it.each(["dispatched to its handler", "still before dispatch"] as const)("settles an earlier generation's in-flight tool call at attach even when that attach never finishes startup (%s at detach)", async stage => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-orphaned-tool-at-attach-"));
  const controlPlaneStatePath = join(stateDirectory, "control-plane", "control-plane-state.json");
  const server = createServer();
  let authority: DurablePrpControlPlane | null = null;
  let admitConnections = true;
  server.on("upgrade", (request, socket, head) => {
    if (!authority || !admitConnections) {
      socket.destroy();
      return;
    }
    authority.handleUpgrade(request, socket, "/runner", head);
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a test listener");
  const registration = vi.fn(async (next: DurablePrpControlPlane) => {
    authority = next;
    return {
      connectUrl: `ws://127.0.0.1:${address.port}/runner`,
      release: async () => { if (authority === next) authority = null; },
    };
  });
  const identity = {
    runnerInstanceId: "runner-orphaned-tool",
    environmentLeaseId: "lease-orphaned-tool",
    runId: "run-orphaned-tool",
    normalizedSessionId: "session-orphaned-tool",
    turnId: "turn-orphaned-tool",
    itemId: "item-orphaned-tool",
  };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--emit-tool-call"),
    stateDirectory,
    prpIdentity: identity,
    lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
    controlPlaneRegistration: registration,
  };
  const recovered = vi.fn(async (call: { operationId: string; callId: string; input: unknown; admission?: "this_controller" | "earlier_controller" }) =>
    recoverToolCallback({ runId: identity.runId, call: { tool: call.operationId, callId: call.callId, arguments: call.input },
      admission: call.admission, recover: async () => null }));
  let reached!: () => void;
  const callReached = new Promise<void>(resolveReached => { reached = resolveReached; });
  let releaseDispatch!: () => void;
  const dispatchGate = new Promise<void>(resolveGate => { releaseDispatch = resolveGate; });
  let gatedOutcome: Promise<unknown> | null = null;
  const OriginalCore = durableControlPlane.DurablePrpControlPlane;
  const coreSpy = vi.spyOn(durableControlPlane, "DurablePrpControlPlane").mockImplementation(function (coreOptions) {
    const dispatch = coreOptions.onSemanticToolInput;
    if (stage === "still before dispatch" && dispatch && !gatedOutcome) {
      coreOptions = { ...coreOptions, onSemanticToolInput: call => {
        reached();
        gatedOutcome = dispatchGate.then(() => dispatch(call));
        return gatedOutcome as ReturnType<typeof dispatch>;
      } };
    }
    return new OriginalCore(coreOptions);
  });
  const first = createCapabilityRunnerdCodexTransport(options);
  first.transport.setServerRequestHandler(() => {
    reached();
    return new Promise<Record<string, unknown>>(() => undefined);
  });
  const generations: Array<ReturnType<typeof createCapabilityRunnerdCodexTransport>> = [];
  let runnerPid: number | null = null;
  const savedToolResults = async () => (JSON.parse(await readFile(controlPlaneStatePath, "utf8")) as { commands: SavedCommand[] })
    .commands.filter(command => command.type === "semantic_tool.result");
  try {
    const opened = (await first.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [taskTool] })).thread as { id: string; sessionId: string };
    runnerPid = first.evidence().runnerPid;
    const runnerStartedAt = first.transport.processInfo!().startedAt;
    await first.transport.request("turn/start", { input: [{ type: "text", text: "Read current task" }] });
    await callReached;
    await first.detachControllerForRestart();
    releaseDispatch();
    await (gatedOutcome as Promise<unknown> | null)?.catch(() => undefined);
    await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
    expect(await savedToolResults()).toEqual([]);

    const adopt = (graceMs?: number) => {
      const generation = createCapabilityRunnerdCodexTransport({
        ...options,
        ...(graceMs === undefined ? {} : { runnerReconnectGraceMs: graceMs }),
        recoverSemanticToolInput: recovered,
        resumeDynamicTools: [taskTool],
        resumeProviderSession: { driverSessionId: opened.id, providerSessionId: opened.sessionId },
        runnerProcessLauncher: () => { throw new Error("duplicate runner spawn attempted"); },
        adoptExistingRunner: {
          pid: runnerPid!, processGroupId: runnerPid, startedAt: runnerStartedAt, signal: () => true,
          isAlive: () => { try { process.kill(runnerPid!, 0); return true; } catch { return false; } },
        },
      });
      generation.transport.setServerRequestHandler(vi.fn(async () => ({ success: true, contentItems: [] })));
      generations.push(generation);
      return generation;
    };

    admitConnections = false;
    const stalled = adopt(1_500);
    await expect(stalled.transport.request("thread/read", {})).rejects.toThrow();
    await stalled.transport.close().catch(() => undefined);
    const settled = await savedToolResults();
    expect(settled).toHaveLength(1);
    expect(JSON.stringify(settled[0]!.payload)).toContain(TOOL_CALLBACK_INTERRUPTED_CODE);

    admitConnections = true;
    const next = adopt();
    await expect(next.transport.request("thread/read", {})).resolves.toEqual(
      expect.objectContaining({ thread: expect.objectContaining({ id: opened.id }) }));
    await vi.waitFor(async () => {
      const results = await savedToolResults();
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ commandId: settled[0]!.commandId, status: "completed" });
    }, { timeout: 10_000 });
    expect(recovered).toHaveBeenCalledTimes(1);
  } finally {
    releaseDispatch();
    coreSpy.mockRestore();
    for (const generation of generations.reverse()) await generation.transport.close().catch(() => undefined);
    await first.transport.close().catch(() => undefined);
    if (runnerPid) {
      try { process.kill(-runnerPid, "SIGKILL"); } catch { runnerPid = null; }
    }
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 120_000);

it("still settles a call stopped before dispatch as not dispatched when the controller closes without a restart", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-not-dispatched-at-close-"));
  const controlPlaneStatePath = join(stateDirectory, "control-plane", "control-plane-state.json");
  let reached!: () => void;
  const callReached = new Promise<void>(resolveReached => { reached = resolveReached; });
  let releaseDispatch!: () => void;
  const dispatchGate = new Promise<void>(resolveGate => { releaseDispatch = resolveGate; });
  let gatedOutcome: Promise<unknown> | null = null;
  const OriginalCore = durableControlPlane.DurablePrpControlPlane;
  const coreSpy = vi.spyOn(durableControlPlane, "DurablePrpControlPlane").mockImplementation(function (coreOptions) {
    const dispatch = coreOptions.onSemanticToolInput;
    if (dispatch && !gatedOutcome) {
      coreOptions = { ...coreOptions, onSemanticToolInput: call => {
        reached();
        gatedOutcome = dispatchGate.then(() => dispatch(call));
        return gatedOutcome as ReturnType<typeof dispatch>;
      } };
    }
    return new OriginalCore(coreOptions);
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--emit-tool-call"),
    stateDirectory,
  });
  bundle.transport.setServerRequestHandler(() => new Promise<Record<string, unknown>>(() => undefined));
  let runnerPid: number | null = null;
  try {
    await bundle.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [taskTool] });
    runnerPid = bundle.evidence().runnerPid;
    await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Read current task" }] });
    await callReached;
    const closing = bundle.transport.close().catch(() => undefined);
    releaseDispatch();
    await (gatedOutcome as Promise<unknown> | null)?.catch(() => undefined);
    await closing;
    const results = (JSON.parse(await readFile(controlPlaneStatePath, "utf8")) as { commands: SavedCommand[] })
      .commands.filter(command => command.type === "semantic_tool.result");
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0]!.payload)).toContain("semantic_tool_not_dispatched");
  } finally {
    releaseDispatch();
    coreSpy.mockRestore();
    await bundle.transport.close().catch(() => undefined);
    if (runnerPid) {
      try { process.kill(-runnerPid, "SIGKILL"); } catch { runnerPid = null; }
    }
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 120_000);

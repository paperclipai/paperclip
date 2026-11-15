import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { recoverToolCallback, TOOL_CALLBACK_INTERRUPTED_CODE } from "../control-plane/orphaned-tool-callback.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

const taskTool = { name: "get_task_context", description: "Read current task", inputSchema: { type: "object", properties: {}, additionalProperties: false } };

type SavedCommand = { commandId: string; type: string; status: string; payload: Record<string, unknown> };

it("settles an earlier generation's in-flight tool call at attach even when that attach never finishes startup", async () => {
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
  const first = createCapabilityRunnerdCodexTransport(options);
  first.transport.setServerRequestHandler(() => new Promise<Record<string, unknown>>(() => undefined));
  const generations: Array<ReturnType<typeof createCapabilityRunnerdCodexTransport>> = [];
  let runnerPid: number | null = null;
  const savedToolResults = async () => (JSON.parse(await readFile(controlPlaneStatePath, "utf8")) as { commands: SavedCommand[] })
    .commands.filter(command => command.type === "semantic_tool.result");
  try {
    const opened = (await first.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [taskTool] })).thread as { id: string; sessionId: string };
    runnerPid = first.evidence().runnerPid;
    const runnerStartedAt = first.transport.processInfo!().startedAt;
    await first.transport.request("turn/start", { input: [{ type: "text", text: "Read current task" }] });
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(controlPlaneStatePath, "utf8")) as { committedEvents: Array<{ eventType: string }> };
      expect(saved.committedEvents.some(event => event.eventType === "semantic_tool.input")).toBe(true);
    }, { timeout: 10_000 });
    await first.detachControllerForRestart();
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

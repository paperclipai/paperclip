import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdCodexTransport, RunnerStallLedger, waitForRunnerCommand } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

type Carried = "late-tool-result" | "close-path-suspend" | "suspend-then-tool-result" | "event-backlog";

const BACKLOG = 400;
const taskTool = { name: "get_task_context", description: "Read current task", inputSchema: { type: "object", properties: {}, additionalProperties: false } };

async function reattachWithCarriedCommands(carried: Carried) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-reattach-carried-"));
  const controlPlaneStatePath = join(stateDirectory, "control-plane", "control-plane-state.json");
  const server = createServer();
  let authority: DurablePrpControlPlane | null = null;
  server.on("upgrade", (request, socket, head) => {
    if (!authority) {
      socket.destroy();
      return;
    }
    authority.handleUpgrade(request, socket, "/runner", head);
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a reattachment test listener");
  const registration = vi.fn(async (next: DurablePrpControlPlane) => {
    authority = next;
    return {
      connectUrl: `ws://127.0.0.1:${address.port}/runner`,
      release: async () => {
        if (authority === next) authority = null;
      },
    };
  });
  const identity = {
    runnerInstanceId: "runner-reattach-carried",
    environmentLeaseId: "lease-reattach-carried",
    runId: "run-reattach-carried",
    normalizedSessionId: "session-reattach-carried",
    turnId: "turn-reattach-carried",
    itemId: "item-reattach-carried",
  };
  const toolCall = carried === "late-tool-result" || carried === "suspend-then-tool-result";
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, ...(toolCall ? ["--emit-tool-call"] : carried === "event-backlog"
      ? ["--hold-turn", "--held-output", "--held-output-count", String(BACKLOG), "--held-output-release-file", join(stateDirectory, "release-output")] : [])),
    stateDirectory,
    prpIdentity: identity,
    lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
    controlPlaneRegistration: registration,
  };
  const first = createCapabilityRunnerdCodexTransport(options);
  let finishTool!: (value: Record<string, unknown>) => void;
  const lateTool = vi.fn(() => new Promise<Record<string, unknown>>(resolveTool => { finishTool = resolveTool; }));
  first.transport.setServerRequestHandler(lateTool);
  let adopted: ReturnType<typeof createCapabilityRunnerdCodexTransport> | null = null;
  let runnerPid: number | null = null;
  try {
    const opened = (await first.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: toolCall ? [taskTool] : [],
    })).thread as { id: string; sessionId: string };
    runnerPid = first.evidence().runnerPid;
    const runnerStartedAt = first.transport.processInfo!().startedAt;
    if (carried === "event-backlog") {
      await first.transport.request("turn/start", { input: [{ type: "text", text: "Keep working" }] });
    }
    if (toolCall) {
      await first.transport.request("turn/start", { input: [{ type: "text", text: "Read current task" }] });
      await vi.waitFor(() => expect(lateTool).toHaveBeenCalledOnce(), { timeout: 5_000 });
    }
    await first.detachControllerForRestart();
    expect(() => process.kill(runnerPid!, 0)).not.toThrow();
    if (toolCall) {
      finishTool({ success: true, contentItems: [{ type: "inputText", text: "task context" }] });
      await vi.waitFor(async () => {
        const saved = JSON.parse(await readFile(controlPlaneStatePath, "utf8")) as { commands: Array<{ type: string; status: string }> };
        expect(saved.commands.at(-1)).toMatchObject({ type: "semantic_tool.result", status: "pending" });
      }, { timeout: 5_000 });
      if (carried === "suspend-then-tool-result") {
        const saved = JSON.parse(await readFile(controlPlaneStatePath, "utf8")) as { commands: Array<Record<string, unknown>> };
        const result = saved.commands.pop()!;
        for (const type of ["runner.drain", "runner.suspend"]) {
          const controllerSeq = saved.commands.length + 1;
          saved.commands.push({
            schema: "paperclip.prp.command.v1",
            commandId: `command_prp_${controllerSeq.toString().padStart(8, "0")}`,
            controllerSeq,
            type,
            issuedAt: new Date().toISOString(),
            payload: {},
            status: "pending",
            result: null,
          });
        }
        saved.commands.push({ ...result, controllerSeq: saved.commands.length + 1 });
        await writeFile(controlPlaneStatePath, JSON.stringify(saved), { mode: 0o600 });
      }
    } else if (carried === "event-backlog") {
      await writeFile(join(stateDirectory, "release-output"), "release");
      await new Promise(resolveWait => setTimeout(resolveWait, 3_000));
    } else {
      const saved = JSON.parse(await readFile(controlPlaneStatePath, "utf8")) as { commands: Array<Record<string, unknown>> };
      for (const type of ["runner.drain", "runner.suspend"]) {
        const controllerSeq = saved.commands.length + 1;
        saved.commands.push({
          schema: "paperclip.prp.command.v1",
          commandId: `command_prp_${controllerSeq.toString().padStart(8, "0")}`,
          controllerSeq,
          type,
          issuedAt: new Date().toISOString(),
          payload: {},
          status: "pending",
          result: null,
        });
      }
      await writeFile(controlPlaneStatePath, JSON.stringify(saved), { mode: 0o600 });
    }

    const redispatched = vi.fn(async () => ({ success: true, contentItems: [] }));
    adopted = createCapabilityRunnerdCodexTransport({
      ...options,
      onAccountingEvent: async () => {
        if (carried === "event-backlog") await new Promise(resolveWait => setTimeout(resolveWait, 100));
      },
      resumeDynamicTools: toolCall ? [taskTool] : [],
      resumeProviderSession: { driverSessionId: opened.id, providerSessionId: opened.sessionId },
      runnerProcessLauncher: () => {
        throw new Error("duplicate runner spawn attempted");
      },
      adoptExistingRunner: {
        pid: runnerPid!,
        processGroupId: runnerPid,
        startedAt: runnerStartedAt,
        signal: () => true,
        isAlive: () => {
          try {
            process.kill(runnerPid!, 0);
            return true;
          } catch {
            return false;
          }
        },
      },
    });
    adopted.transport.setServerRequestHandler(redispatched);
    await expect(adopted.transport.request("thread/read", {})).resolves.toEqual(
      expect.objectContaining({ thread: expect.objectContaining({ id: opened.id }) }),
    );
    expect(() => process.kill(runnerPid!, 0)).not.toThrow();
    const commands = authority!.store.state.commands;
    expect(commands.map(command => command.controllerSeq)).toEqual(commands.map((_command, index) => index + 1));
    expect(commands.some(command => command.type === "runner.suspend")).toBe(false);
    if (toolCall) {
      expect(commands.filter(command => command.type === "semantic_tool.result")).toMatchObject([{ status: "completed" }]);
      expect(redispatched).not.toHaveBeenCalled();
    }
  } finally {
    await adopted?.transport.close().catch(() => undefined);
    await first.transport.close().catch(() => undefined);
    if (runnerPid) {
      try { process.kill(-runnerPid, "SIGKILL"); } catch { /* already exited */ }
    }
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

it.each([
  ["a tool result its predecessor queued after the restart", "late-tool-result"],
  ["a runner.suspend left by an earlier attempt's close path", "close-path-suspend"],
  ["a runner.suspend with a tool result queued after it", "suspend-then-tool-result"],
  ["an event backlog ahead of its recovery snapshot result", "event-backlog"],
] as const)("reattaches a live runner past %s", async (_label, carried) => {
  await reattachWithCarriedCommands(carried);
}, 120_000);

function pendingCommand() {
  return { status: "pending" };
}

it("keeps waiting past the deadline while the runner's answer is queued behind frames the controller is still committing", async () => {
  let progressAt = Date.now();
  const command = pendingCommand();
  const advancing = setInterval(() => { progressAt = Date.now(); }, 5);
  setTimeout(() => { command.status = "completed"; }, 150);
  try {
    await expect(waitForRunnerCommand({
      type: "session.snapshot",
      deadline: Date.now() + 20,
      abortOnClose: false,
      isClosed: () => false,
      throwIfFailed: () => undefined,
      command: () => command,
      runnerHasExited: async () => false,
      failureCode: () => "provider_transport_failed",
      answeredProgressAt: () => progressAt,
    })).resolves.toBeUndefined();
  } finally {
    clearInterval(advancing);
  }
});

it("times out when the runner's queued answer stops advancing", async () => {
  await expect(waitForRunnerCommand({
    type: "session.snapshot",
    deadline: Date.now() + 20,
    abortOnClose: false,
    isClosed: () => false,
    throwIfFailed: () => undefined,
    command: () => pendingCommand(),
    runnerHasExited: async () => false,
    failureCode: () => "provider_transport_failed",
    answeredProgressAt: () => Date.now() - 31_000,
  })).rejects.toThrow("provider_transport_failed: PRP command session.snapshot timed out");
});

it("leaves later barriers that share an admission deadline their time after an answered barrier ran past it", async () => {
  const clock = new RunnerStallLedger();
  const deadline = clock.now() + 20;
  let progressAt = Date.now();
  const drain = pendingCommand();
  const snapshot = pendingCommand();
  const advancing = setInterval(() => { progressAt = Date.now(); }, 5);
  setTimeout(() => { drain.status = "completed"; }, 150);
  const wait = (type: string, command: { status: string }, answered: () => number | null) => waitForRunnerCommand({
    type,
    deadline,
    clock,
    abortOnClose: false,
    isClosed: () => false,
    throwIfFailed: () => undefined,
    command: () => command,
    runnerHasExited: async () => false,
    failureCode: () => "provider_transport_failed",
    answeredProgressAt: answered,
  });
  try {
    await expect(wait("runner.drain", drain, () => progressAt)).resolves.toBeUndefined();
  } finally {
    clearInterval(advancing);
  }
  setTimeout(() => { snapshot.status = "completed"; }, 50);
  await expect(wait("session.snapshot", snapshot, () => null)).resolves.toBeUndefined();
});

it("completes a command whose answer arrives during the last sleep before its deadline", async () => {
  vi.useFakeTimers();
  try {
    const command = pendingCommand();
    const deadline = Date.now() + 25;
    const waited = waitForRunnerCommand({
      type: "runner.drain",
      deadline,
      abortOnClose: false,
      isClosed: () => false,
      throwIfFailed: () => undefined,
      command: () => command,
      runnerHasExited: async () => false,
      failureCode: () => "provider_transport_failed",
      answeredProgressAt: () => null,
    });
    const outcome = waited.then(() => "completed", (error: unknown) => String(error));
    await vi.advanceTimersByTimeAsync(20);
    command.status = "completed";
    await vi.advanceTimersByTimeAsync(10);
    expect(Date.now()).toBeGreaterThanOrEqual(deadline);
    await expect(outcome).resolves.toBe("completed");
  } finally {
    vi.useRealTimers();
  }
});

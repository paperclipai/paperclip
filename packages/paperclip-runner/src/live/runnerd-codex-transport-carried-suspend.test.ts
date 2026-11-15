import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCapabilityRunnerdCodexTransport, runnerdRecoveryInternals } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

/**
 * A server freeze while the controller suspends a finished turn can stop the
 * runner inside `runner.suspend`: the runner journaled the command, its
 * outcome is not recorded, and the controller still lists it as pending. The
 * next same-run attempt starts a new runner. That runner settles the old
 * suspend from the welcome (as `execution_indeterminate`; it never runs it
 * again), records `suspended` and exits with code 0 before it accepts any of
 * this attempt's commands. The attempt restarts the runner in place once, and
 * the resume completes in the same attempt without another provider turn.
 *
 * `fenced` is the state a released build can leave: the controller already
 * recorded the suspend as failed and the runner kept its terminal fence. The
 * next runner reconciles that fence, keeps a provider cleanup fence and exits.
 * That runner would refuse new work, so the attempt is not restarted in place:
 * any exit without the exact proof keeps the earlier failure.
 */
it.each(["journaled", "fenced"] as const)("restarts in place only a runner that settled the previous attempt's suspend (%s)", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-carried-suspend-"));
  const callsPath = join(root, "calls.log");
  const identity = {
    runnerInstanceId: "carried-suspend-runner",
    environmentLeaseId: "carried-suspend-lease",
    runId: "carried-suspend-run",
    normalizedSessionId: "carried-suspend-session",
    turnId: "carried-suspend-turn",
    itemId: "carried-suspend-item",
  };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(root, "--call-log", callsPath),
    stateDirectory: root,
  };
  const kill = (pid: number | null | undefined) => {
    if (!pid) return;
    try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const first = createCapabilityRunnerdCodexTransport({ ...options, prpIdentity: identity });
  let resumed: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  try {
    const opened = await first.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] });
    const openedThread = opened.thread as { id: string; sessionId: string };
    const thread = { id: openedThread.id, sessionId: openedThread.sessionId };
    await first.transport.close();

    // Rewrite both journals to the moment of the freeze: the runner journaled
    // the suspend before its effect; the controller never saw its result.
    const controlPath = join(root, "control-plane", "control-plane-state.json");
    const control = JSON.parse(await readFile(controlPath, "utf8"));
    const suspend = control.commands.findLast((command: { type: string }) => command.type === "runner.suspend");
    expect(suspend).toMatchObject({ status: "completed" });
    expect(control.commands.at(-1).commandId).toBe(suspend.commandId);
    const indeterminate = { code: "execution_indeterminate", message: "runner recovered after journaling this command; it will not execute twice" };
    Object.assign(suspend, mode === "journaled" ? { status: "pending", result: null } : {
      status: "failed",
      result: { commandId: suspend.commandId, controllerSeq: suspend.controllerSeq, commandType: "runner.suspend",
        status: "failed", result: indeterminate },
    });
    await writeFile(controlPath, JSON.stringify(control));
    const runnerPath = join(root, "runner", "runner-state.json");
    const runner = JSON.parse(await readFile(runnerPath, "utf8"));
    expect(runner.lastControllerCommandSeq).toBe(suspend.controllerSeq);
    runner.processedCommands[suspend.commandId] = {
      ...runner.processedCommands[suspend.commandId],
      ...(mode === "journaled"
        ? { status: "pending", result: { code: "execution_indeterminate", message: "command was journaled before its effect" } }
        : { status: "indeterminate", result: indeterminate }),
    };
    runner.lifecycle = mode === "journaled" ? "ready" : "suspended";
    runner.pendingTerminalDelivery = mode === "journaled" ? null : {
      commandId: suspend.commandId, controllerSeq: suspend.controllerSeq, commandType: "runner.suspend", lifecycle: "suspended",
    };
    await writeFile(runnerPath, JSON.stringify(runner));
    const callsBefore = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);

    resumed = createCapabilityRunnerdCodexTransport({
      ...options,
      prpIdentity: identity,
      resumeProviderSession: { driverSessionId: thread.id, providerSessionId: thread.sessionId },
    });
    if (mode === "fenced") {
      await expect(resumed.transport.request("thread/read", {})).rejects.toThrow(
        "runnerd exited unexpectedly with code 0",
      );
      expect(resumed.evidence().diagnostics).not.toContain(
        "runner settled a suspend left by an earlier attempt and exited; restarting it in place",
      );
      return;
    }
    expect((await resumed.transport.request("thread/read", {})).thread).toMatchObject(thread);
    expect(resumed.evidence().diagnostics).toContain(
      "runner settled a suspend left by an earlier attempt and exited; restarting it in place",
    );
    const recovered = JSON.parse(await readFile(controlPath, "utf8"));
    expect(recovered.commands.find((command: { commandId: string }) => command.commandId === suspend.commandId))
      .toMatchObject({ status: "failed", result: { result: { code: "execution_indeterminate" } } });
    const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/).slice(callsBefore.length);
    expect(calls.filter(call => call === "turn/start")).toHaveLength(0);
  } finally {
    await Promise.allSettled([first.transport.close(), resumed?.transport.close()]);
    for (const bundle of [first, resumed]) {
      const evidence = bundle?.evidence();
      kill(evidence?.runnerPid);
      kill(evidence?.providerPid);
    }
    await vi.waitFor(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("restarts only for the exact settled suspend left by an earlier attempt", () => {
  const prove = runnerdRecoveryInternals.carriedSuspendSettlementProven;
  const identity = {
    runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run",
    normalizedSessionId: "session", turnId: "turn", itemId: "item",
  };
  const runnerState = (overrides: Record<string, unknown> = {}) => ({
    schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "suspended",
    pendingTerminalDelivery: null, pendingProviderCleanup: null, lastControllerCommandSeq: 3,
    processedCommands: { suspend: { commandId: "suspend", controllerSeq: 3, commandType: "runner.suspend", status: "indeterminate" } },
    ...overrides,
  });
  const commands = (overrides: Record<string, unknown> = {}, later: Record<string, unknown>[] = []) => [
    { commandId: "prepare", controllerSeq: 1, type: "run.prepare", status: "completed" },
    { commandId: "turn", controllerSeq: 2, type: "turn.start", status: "completed" },
    { commandId: "suspend", controllerSeq: 3, type: "runner.suspend", status: "failed", ...overrides },
    { commandId: "probe", controllerSeq: 4, type: "runner.drain", status: "pending" },
    ...later,
  ] as { commandId: string; controllerSeq: number; type: string; status: string }[];
  const proven = (state = runnerState(), journal = commands(), carriedCommandCount = 3) =>
    prove({ runnerState: state, identity, commands: journal, carriedCommandCount });

  expect(proven()).toBe(true);
  // This attempt queued the suspend, as a normal close does.
  expect(proven(runnerState(), commands(), 2)).toBe(false);
  // The controller has not settled it yet.
  expect(proven(runnerState(), commands({ status: "pending" }))).toBe(false);
  // The last command is not a suspend.
  expect(proven(runnerState(), commands({ type: "runner.shutdown" }))).toBe(false);
  // The runner went on to a command of this attempt.
  expect(proven(runnerState({ lastControllerCommandSeq: 4 }))).toBe(false);
  expect(proven(runnerState(), commands({}, []).map(command =>
    command.commandId === "probe" ? { ...command, status: "completed" } : command))).toBe(false);
  // The runner did not rest cleanly suspended.
  expect(proven(runnerState({ lifecycle: "ready" }))).toBe(false);
  expect(proven(runnerState({ pendingTerminalDelivery: { commandId: "suspend" } }))).toBe(false);
  expect(proven(runnerState({ pendingProviderCleanup: { commandId: "suspend" } }))).toBe(false);
  // The runner's receipt names another command or another authority.
  expect(proven(runnerState({ processedCommands: { suspend: { commandId: "suspend", controllerSeq: 3,
    commandType: "runner.shutdown", status: "completed" } } }))).toBe(false);
  expect(proven(runnerState({ processedCommands: {} }))).toBe(false);
  expect(proven(runnerState({ runId: "other-run" }))).toBe(false);
});

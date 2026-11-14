import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

/**
 * A follow-up run (for example the run that carries a person's answer) starts
 * a new runner and attaches it to the saved conversation. A restart can kill
 * the runner and its provider after the runner journaled `run.attach` and
 * before it finished. The restored runner then settles that command as
 * `execution_indeterminate` and will never execute it again. No turn ran for
 * this run, so the same-run resume attaches again with a new command instead
 * of failing on the old one.
 *
 * With `startupFence`, the kill also landed while the attachment was launching
 * the provider: the provider state holds a spawned startup attempt over a
 * prepared (saved, settled) thread, and that provider process is gone.
 */
it.each([false, true])("re-attaches a follow-up whose run.attach a restart cut off (startup fence: %s)", async (startupFence) => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-cut-attach-"));
  const callsPath = join(root, "calls.log");
  const identity = {
    runnerInstanceId: "cut-attach-runner",
    environmentLeaseId: "cut-attach-lease",
    runId: "asking-run",
    normalizedSessionId: "cut-attach-session",
    turnId: "asking-turn",
    itemId: "asking-item",
  };
  const answerIdentity = { ...identity, runId: "answer-run", turnId: "answer-turn", itemId: "answer-item" };
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
  const alive = (pid: number | null | undefined) => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const asking = createCapabilityRunnerdCodexTransport({ ...options, prpIdentity: identity });
  let answer: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  let resumed: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  try {
    const opened = await asking.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] });
    const openedThread = opened.thread as { id: string; sessionId: string };
    const thread = { id: openedThread.id, sessionId: openedThread.sessionId };
    await asking.transport.close();

    const resumeProviderSession = { driverSessionId: thread.id, providerSessionId: thread.sessionId };
    answer = createCapabilityRunnerdCodexTransport({ ...options, prpIdentity: answerIdentity, resumeProviderSession });
    expect((await answer.transport.request("thread/read", {})).thread).toMatchObject(thread);
    const owner = answer.evidence();
    await answer.detachControllerForRestart();
    kill(owner.runnerPid);
    kill(owner.providerPid);
    await vi.waitFor(() => { expect(alive(owner.runnerPid)).toBe(false); expect(alive(owner.providerPid)).toBe(false); });

    // Rewrite both journals to the moment of the kill: run.attach journaled,
    // its outcome not yet recorded, nothing after it.
    const controlPath = join(root, "control-plane", "control-plane-state.json");
    const control = JSON.parse(await readFile(controlPath, "utf8"));
    expect(control.identity.runId).toBe("answer-run");
    const attach = control.commands.findLast((command: { type: string }) => command.type === "run.attach");
    control.commands = control.commands.filter((command: { controllerSeq: number }) => command.controllerSeq <= attach.controllerSeq);
    Object.assign(attach, { status: "pending", result: null });
    await writeFile(controlPath, JSON.stringify(control));
    const runnerPath = join(root, "runner", "runner-state.json");
    const runner = JSON.parse(await readFile(runnerPath, "utf8"));
    const processed = runner.processedCommands as Record<string, { commandId: string; controllerSeq: number }>;
    for (const [key, command] of Object.entries(processed)) {
      if (command.controllerSeq > attach.controllerSeq) delete processed[key];
      else if (command.commandId === attach.commandId) processed[key] = { ...command, status: "pending", result: null } as never;
    }
    for (const key of Object.keys(runner.processedCommandFingerprints ?? {})) {
      if (!(key in processed)) delete runner.processedCommandFingerprints[key];
    }
    runner.lastControllerCommandSeq = attach.controllerSeq;
    runner.lifecycle = "ready";
    await writeFile(runnerPath, JSON.stringify(runner));
    if (startupFence) {
      const providerPath = join(root, "runner", "codex-provider-state.json");
      const provider = JSON.parse(await readFile(providerPath, "utf8"));
      provider.lifecycle = "prepared";
      provider.startupAttempt = {
        schema: "paperclip.provider_startup.v1",
        launchId: "00000000-0000-4000-8000-000000000001",
        phase: "spawned",
        trigger: "ensure",
        attemptedProcessGeneration: provider.providerProcessGeneration + 1,
        origin: { runnerInstanceId: answerIdentity.runnerInstanceId, runId: answerIdentity.runId,
          normalizedSessionId: answerIdentity.normalizedSessionId, turnId: answerIdentity.turnId, itemId: answerIdentity.itemId },
        command: { commandId: attach.commandId, controllerSeq: attach.controllerSeq, commandType: "run.attach" },
        configurationFingerprint: `sha256:${"0".repeat(64)}`,
        requestedThreadId: thread.id,
        authenticatedThreadId: null,
        processId: owner.providerPid,
        processGroupId: owner.providerPid,
        failedStage: null,
        directChildExitObserved: false,
        exitCode: null,
        signal: null,
        processTreeRetired: false,
      };
      await writeFile(providerPath, JSON.stringify(provider));
    }
    const callsBefore = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);

    resumed = createCapabilityRunnerdCodexTransport({ ...options, prpIdentity: answerIdentity, resumeProviderSession });
    expect((await resumed.transport.request("thread/read", {})).thread).toMatchObject(thread);
    const recovered = JSON.parse(await readFile(controlPath, "utf8"));
    const attachments = recovered.commands.filter((command: { type: string }) => command.type === "run.attach");
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({ commandId: attach.commandId, status: "failed",
      result: { result: { code: "execution_indeterminate" } } });
    expect(attachments[1]).toMatchObject({ status: "completed", payload: attach.payload });
    const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/).slice(callsBefore.length);
    expect(calls.filter(call => call === "thread/resume")).toHaveLength(1);
    expect(calls.filter(call => call === "turn/start")).toHaveLength(0);
  } finally {
    await Promise.allSettled([asking.transport.close(), answer?.transport.close(), resumed?.transport.close()]);
    for (const bundle of [asking, answer, resumed]) {
      const evidence = bundle?.evidence();
      kill(evidence?.runnerPid);
      kill(evidence?.providerPid);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

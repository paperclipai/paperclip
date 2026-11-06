import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const getSandbox = vi.hoisted(() => vi.fn());
vi.mock("@daytonaio/sdk", () => ({
  Daytona: class { get = getSandbox; },
  DaytonaNotFoundError: class extends Error {},
  DaytonaTimeoutError: class extends Error {},
}));

import plugin, { __resetDaytonaSandboxHandleCacheForTest, __setDaytonaPluginContextForTest } from "./plugin.js";

function fixture() {
  const process = {
    createSession: vi.fn().mockResolvedValue(undefined),
    executeSessionCommand: vi.fn().mockResolvedValue({ cmdId: "fixture-command" }),
    getSessionCommand: vi.fn<(...args: string[]) => Promise<{ exitCode: number | undefined }>>().mockResolvedValue({ exitCode: 0 }),
    getSessionCommandLogs: vi.fn<(session: string, command: string, stdout?: (chunk: string) => void, stderr?: (chunk: string) => void) => Promise<{ stdout: string; stderr: string } | void>>().mockImplementation(async (_session, _command, stdout) => {
      if (stdout) return new Promise(() => {});
      return { stdout: "complete stdout\n", stderr: "complete stderr\n" };
    }),
  };
  getSandbox.mockResolvedValue({ id: "fixture-sandbox", state: "started", process });
  const execute = (commandTimeoutMs = 2_000) => plugin.definition.onEnvironmentExecute!({
    driverKey: "daytona", companyId: "fixture-company", environmentId: "fixture-environment",
    config: { apiKey: "fixture-not-a-key", timeoutMs: 30_000 },
    lease: { providerLeaseId: "fixture-sandbox" }, command: "printf", args: ["fixture"],
    commandTimeoutMs,
  });
  return { process, execute };
}

describe("Daytona completed session commands", () => {
  beforeEach(() => {
    __resetDaytonaSandboxHandleCacheForTest();
    getSandbox.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetDaytonaSandboxHandleCacheForTest();
  });

  it("returns a finished command's final separated logs without opening a follow socket", async () => {
    const { process, execute } = fixture();
    let settled = false;
    const pending = execute().then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ exitCode: 0, timedOut: false, stdout: "complete stdout\n", stderr: "complete stderr\n" });
    expect(process.getSessionCommandLogs).toHaveBeenCalledExactlyOnceWith(expect.any(String), "fixture-command");
    expect(process.executeSessionCommand).toHaveBeenCalledTimes(1);
  });

  it("streams a still-running command and reconciles its final snapshot", async () => {
    const { process, execute } = fixture();
    process.getSessionCommand.mockResolvedValueOnce({ exitCode: undefined });
    process.getSessionCommandLogs.mockImplementation(async (_session, _command, stdout) => {
      if (stdout) { stdout("prefix "); return; }
      return { stdout: "prefix complete\n", stderr: "error\n" };
    });
    expect(await execute()).toMatchObject({ exitCode: 0, timedOut: false, stdout: "prefix complete\n", stderr: "error\n" });
    expect(process.getSessionCommandLogs.mock.calls.filter(call => call[2])).toHaveLength(1);
  });

  it("retains a completed status response that takes 300ms without opening a follow socket", async () => {
    const { process, execute } = fixture();
    process.getSessionCommand.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ exitCode: 0 }), 300)));
    let settled = false;
    const pending = execute().then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(600);
    const settledWithinObservation = settled;
    if (!settled) await vi.advanceTimersByTimeAsync(1_500);
    expect(await pending).toMatchObject({ exitCode: 0, timedOut: false, stdout: "complete stdout\n", stderr: "complete stderr\n" });
    expect(settledWithinObservation).toBe(true);
    expect(process.getSessionCommandLogs.mock.calls.filter(call => call[2])).toHaveLength(0);
    expect(process.executeSessionCommand).toHaveBeenCalledTimes(1);
  });

  it("bounds an unavailable initial status read and retains the working stream", async () => {
    const { process, execute } = fixture();
    process.getSessionCommand.mockImplementationOnce(() => new Promise(() => {}));
    process.getSessionCommandLogs.mockImplementation(async (_session, _command, stdout) => {
      if (stdout) { stdout("complete stdout\n"); return; }
      return { stdout: "complete stdout\n", stderr: "complete stderr\n" };
    });
    const pending = execute();
    await vi.advanceTimersByTimeAsync(499);
    expect(process.getSessionCommandLogs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toMatchObject({ exitCode: 0, timedOut: false, stdout: "complete stdout\n", stderr: "complete stderr\n" });
    expect(process.getSessionCommandLogs.mock.calls.filter(call => call[2])).toHaveLength(1);
  });

  it("retains stream recovery after the initial status request rejects", async () => {
    const { process, execute } = fixture();
    process.getSessionCommand.mockRejectedValueOnce(new Error("status transport unavailable"));
    process.getSessionCommandLogs.mockImplementation(async (_session, _command, stdout) => {
      if (stdout) { stdout("complete stdout\n"); return; }
      return { stdout: "complete stdout\n", stderr: "complete stderr\n" };
    });
    expect(await execute()).toMatchObject({ exitCode: 0, timedOut: false, stdout: "complete stdout\n", stderr: "complete stderr\n" });
    expect(process.executeSessionCommand).toHaveBeenCalledTimes(1);
  });

  it("does not treat a visible exit as proof that final logs were read", async () => {
    const { process, execute } = fixture();
    process.getSessionCommandLogs.mockImplementation(() => new Promise(() => {}));
    const pending = execute(100);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ exitCode: null, timedOut: true,
      metadata: { timeoutScope: "session_log_observation", commandExitConfirmed: true, observedExitCode: 0 } });
  });

  it("keeps the total command deadline while the initial status is unavailable", async () => {
    const { process, execute } = fixture();
    process.getSessionCommand.mockImplementation(() => new Promise(() => {}));
    const pending = execute(100);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ exitCode: null, timedOut: true });
    expect(process.executeSessionCommand).toHaveBeenCalledTimes(1);
    expect(process.getSessionCommandLogs).not.toHaveBeenCalled();
  });

  it.each([0, 7])("settles exit %s from its final snapshot before the follow socket closes", async (exitCode) => {
    const { process, execute } = fixture();
    process.getSessionCommand.mockResolvedValueOnce({ exitCode: undefined }).mockResolvedValue({ exitCode });
    let lateOutput: ((chunk: string) => void) | undefined;
    process.getSessionCommandLogs.mockImplementation(async (_session, _command, stdout) => {
      if (stdout) {
        lateOutput = stdout;
        stdout("complete ");
        return new Promise(() => {});
      }
      return { stdout: "complete stdout\n", stderr: "complete stderr\n" };
    });
    let settled = false;
    const pending = execute(10_000).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(250);
    const settledBeforeSocketClose = settled;
    if (!settled) await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(settledBeforeSocketClose).toBe(true);
    expect(result).toMatchObject({ exitCode, timedOut: false, stdout: "complete stdout\n", stderr: "complete stderr\n" });
    lateOutput?.("late bytes must be ignored");
    expect(result.stdout).toBe("complete stdout\n");
    expect(process.executeSessionCommand).toHaveBeenCalledTimes(1);
  });

  it("bounds the early status reads while a longer command keeps streaming", async () => {
    const { process, execute } = fixture();
    process.getSessionCommand.mockResolvedValue({ exitCode: undefined });
    let closeStream!: () => void;
    process.getSessionCommandLogs.mockImplementation(async (_session, _command, stdout) => {
      if (stdout) { stdout("complete "); return new Promise<void>(resolve => { closeStream = resolve; }); }
      return { stdout: "complete stdout\n", stderr: "complete stderr\n" };
    });
    let settled = false;
    const pending = execute(10_000).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(settled).toBe(false);
    expect(process.getSessionCommand).toHaveBeenCalledTimes(5);
    process.getSessionCommand.mockResolvedValue({ exitCode: 0 });
    closeStream();
    expect(await pending).toMatchObject({ exitCode: 0, timedOut: false, stdout: "complete stdout\n" });
    expect(process.executeSessionCommand).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["rejected", "unavailable"])("retains the healthy stream after a %s early exit read", async (failure) => {
    const { process, execute } = fixture();
    process.getSessionCommand.mockResolvedValueOnce({ exitCode: undefined });
    if (failure === "rejected") process.getSessionCommand.mockRejectedValueOnce(new Error("early status unavailable"));
    else process.getSessionCommand.mockImplementationOnce(() => new Promise(() => {}));
    let closeStream!: () => void;
    process.getSessionCommandLogs.mockImplementation(async (_session, _command, stdout) => {
      if (stdout) return new Promise<void>(resolve => { closeStream = resolve; });
      return { stdout: "complete stdout\n", stderr: "complete stderr\n" };
    });
    let settled = false;
    const pending = execute(10_000).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(600);
    expect(settled).toBe(false);
    expect(process.getSessionCommand).toHaveBeenCalledTimes(2);
    closeStream();
    expect(await pending).toMatchObject({ exitCode: 0, timedOut: false, stdout: "complete stdout\n", stderr: "complete stderr\n" });
    expect(process.executeSessionCommand).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the final snapshot deadline after observing an early exit", async () => {
    const { process, execute } = fixture();
    process.getSessionCommand.mockResolvedValueOnce({ exitCode: undefined });
    process.getSessionCommandLogs.mockImplementation(() => new Promise(() => {}));
    const pending = execute(100);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ exitCode: null, timedOut: true,
      metadata: { timeoutScope: "session_log_observation", commandExitConfirmed: true, observedExitCode: 0 } });
    expect(process.executeSessionCommand).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops early exit reads at the original command deadline", async () => {
    const { process, execute } = fixture();
    process.getSessionCommand.mockResolvedValueOnce({ exitCode: undefined }).mockImplementation(() => new Promise(() => {}));
    const pending = execute(100);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ exitCode: null, timedOut: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(process.getSessionCommand).toHaveBeenCalledTimes(2);
    expect(process.executeSessionCommand).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconciles UTF-8 output and fences late follow callbacks after an early exit", async () => {
    const { process, execute } = fixture();
    const log = vi.fn();
    const restore = __setDaytonaPluginContextForTest({ execution: { log } } as unknown as PluginContext);
    process.getSessionCommand.mockResolvedValueOnce({ exitCode: undefined });
    let lateStdout!: (chunk: string) => void;
    let lateStderr!: (chunk: string) => void;
    process.getSessionCommandLogs.mockImplementation(async (_session, _command, stdout, stderr) => {
      if (stdout) {
        lateStdout = stdout;
        lateStderr = stderr!;
        stdout("α");
        return new Promise(() => {});
      }
      return { stdout: "αβ🚀\n", stderr: "γδ\n" };
    });
    try {
      const pending = execute();
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toMatchObject({ exitCode: 0, timedOut: false, stdout: "αβ🚀\n", stderr: "γδ\n" });
      const deliveredCount = log.mock.calls.length;
      lateStdout("late stdout");
      lateStderr("late stderr");
      expect(log).toHaveBeenCalledTimes(deliveredCount);
      expect(process.executeSessionCommand).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { restore(); }
  });
});

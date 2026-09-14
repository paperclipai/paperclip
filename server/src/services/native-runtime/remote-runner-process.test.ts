import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { createRemoteRunnerProcessLauncher, type RemoteRunnerProcessControls } from "./remote-runner-process.js";

const owner = { version: 1 as const, pid: 4321, uid: 1000, processGroupId: 4321,
  bootId: "1d2c2412-544b-4f04-955e-c41256fe5866", startTicks: "123456" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(patch: Partial<RemoteRunnerProcessControls> = {}, onSpawn?: () => Promise<void>) {
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async call => {
    if (call.args?.[2] !== "paperclip-runner-launch") throw new Error("No command authority after launch");
    return { stdout: `paperclip-process-v1|${call.args[4]}|${owner.pid}|${owner.uid}|${owner.processGroupId}|${owner.bootId}|${owner.startTicks}\n`,
      stderr: "", exitCode: 0, timedOut: false, signal: null, pid: null, startedAt: null };
  });
  const processExecute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async () => { throw new Error("No generic process authority"); });
  const controls = { inspect: vi.fn<RemoteRunnerProcessControls["inspect"]>(async () => "exited"),
    signal: vi.fn<RemoteRunnerProcessControls["signal"]>(async () => "signalled"),
    readState: vi.fn<RemoteRunnerProcessControls["readState"]>(async () => ({ lifecycle: "ready" })), ...patch };
  const start = () => createRemoteRunnerProcessLauncher({
    target: { kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd: "/workspace" },
    runner: { execute }, processRunner: { execute: processExecute }, processControls: controls,
    remoteBinary: "/runtime/runner", processIdentityPath: "/runtime/identity", stateDirectory: "/runtime/state",
    diagnosticsDirectory: "/runtime/diagnostics", runnerInstanceId: "runner", onSpawn,
  })({ command: "runner", args: ["--runner-id", "runner"], cwd: "/workspace", environment: {} });
  return { start, controls, execute, processExecute };
}

afterEach(() => { vi.useRealTimers(); });
describe("remote runner monitoring through restricted controls", () => {
  it("reads retained state without requiring generic diagnostics or commands", async () => {
    const f = fixture();
    await expect(f.start().completion).resolves.toMatchObject({ stderr: "runner_remote_process_exited lifecycle=ready" });
    expect(f.controls.inspect).toHaveBeenCalledExactlyOnceWith(owner);
    expect(f.controls.readState).toHaveBeenCalledExactlyOnceWith(owner);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.processExecute).not.toHaveBeenCalled();
  });

  it.each(["unverified", "mismatch", "malformed", "throws"])("preserves uncertain ownership on %s inspection", async outcome => {
    const f = fixture({ inspect: async () => {
      if (outcome === "throws") throw new Error("unavailable");
      return outcome === "malformed" ? undefined as never : outcome as "unverified" | "mismatch";
    } });
    await expect(f.start().completion).rejects.toThrow(outcome === "throws" ? "unavailable" : "verification_unavailable");
    expect(f.controls.readState).not.toHaveBeenCalled();
    expect(f.processExecute).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("waits through pending observations, then follows the current controls without replaying launch", async () => {
    vi.useFakeTimers();
    const inspected = deferred<void>();
    let phase = "finalizing", settled = false;
    const visits: string[] = [];
    const f = fixture({ inspect: async observed => {
      expect(observed).toEqual(owner); visits.push(phase); inspected.resolve();
      return phase === "idle" ? "exited" : "pending";
    } });
    const handle = f.start();
    void handle.completion.then(() => { settled = true; });
    await inspected.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    phase = "handoff";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    phase = "idle";
    await vi.advanceTimersByTimeAsync(1_000);
    await handle.completion;
    expect(visits).toEqual(["finalizing", "finalizing", "handoff", "idle"]);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.processExecute).not.toHaveBeenCalled();
  });

  it.each(["unverified", "sync_throw"])("awaits a concurrent %s signal even when inspection reports exit", async outcome => {
    const inspection = deferred<"exited">(), entered = deferred<void>(), signalResult = deferred<"unverified">();
    const f = fixture({ inspect: async () => { entered.resolve(); return inspection.promise; }, signal: () => {
      if (outcome === "sync_throw") throw new Error("revoked");
      return signalResult.promise;
    } });
    const handle = f.start();
    const rejected = expect(handle.completion).rejects.toThrow("signal_unverified");
    await entered.promise;
    expect(handle.child.kill("SIGTERM")).toBe(true);
    inspection.resolve("exited");
    signalResult.resolve("unverified");
    await rejected;
    expect(f.controls.readState).not.toHaveBeenCalled();
    expect(f.processExecute).not.toHaveBeenCalled();
  });

  it("does not defer a rejected handoff signal until a later owner can accept it", async () => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    const signal = vi.fn<RemoteRunnerProcessControls["signal"]>(async () => "unverified");
    const f = fixture({ inspect: async () => { entered.resolve(); return "pending"; }, signal });
    const handle = f.start(), rejected = expect(handle.completion).rejects.toThrow("signal_unverified");
    await entered.promise;
    expect(handle.child.kill("SIGKILL")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(signal).toHaveBeenCalledExactlyOnceWith(owner, "SIGKILL");
    expect(f.processExecute).not.toHaveBeenCalled();
  });

  it("invokes signal authority before child.kill returns, even if the next run takes over immediately", async () => {
    const entered = deferred<void>(), inspection = deferred<"exited">();
    let currentRun = "old";
    const calledBy: string[] = [];
    const f = fixture({ inspect: () => { entered.resolve(); return inspection.promise; }, signal: async () => {
      calledBy.push(currentRun); return "signalled";
    } });
    const handle = f.start();
    await entered.promise;
    expect(handle.child.kill("SIGTERM")).toBe(true);
    currentRun = "new";
    inspection.resolve("exited");
    await handle.completion;
    expect(calledBy).toEqual(["old"]);
  });

  it("closes signal admission once exit is observed, before waiting for final diagnostics", async () => {
    const entered = deferred<void>(), state = deferred<Record<string, unknown>>();
    const f = fixture({ readState: () => { entered.resolve(); return state.promise; } });
    const handle = f.start();
    await entered.promise;
    expect(handle.child.kill("SIGTERM")).toBe(false);
    expect(f.controls.signal).not.toHaveBeenCalled();
    state.resolve({ lifecycle: "ready" });
    await handle.completion;
  });

  it("does not let a callback mutate the receipt used by later operations", async () => {
    const f = fixture({ inspect: async observed => { observed.pid++; return "exited"; } });
    await f.start().completion;
    expect(f.controls.readState).toHaveBeenCalledExactlyOnceWith(owner);
  });

  it("does not fall back when optional diagnostics and state reads fail", async () => {
    const f = fixture({ readDiagnostics: () => { throw new Error("denied"); }, readState: () => { throw new Error("denied"); } });
    await expect(f.start().completion).resolves.toMatchObject({ stderr: "runner_remote_process_exited lifecycle=unavailable" });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.processExecute).not.toHaveBeenCalled();
  });

  it("refuses restricted controls for a launcher without kernel receipts", () => {
    expect(() => createRemoteRunnerProcessLauncher({
      target: { kind: "remote", transport: "sandbox", providerKey: "other", remoteCwd: "/workspace" },
      runner: { execute: vi.fn() }, processControls: fixture().controls,
      remoteBinary: "runner", processIdentityPath: "identity", stateDirectory: "state", diagnosticsDirectory: "diagnostics", runnerInstanceId: "runner",
    })).toThrow("controls_require_kernel_receipt");
  });
});

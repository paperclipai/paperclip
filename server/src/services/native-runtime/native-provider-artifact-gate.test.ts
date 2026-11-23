import { describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeProviderArtifactSource } from "./native-provider-artifacts.js";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { NativeProviderArtifactTransferTimeoutError } from "./native-provider-artifacts.js";
import { NativeFailedBeforeProviderTurnError } from "./failed-before-provider-turn.js";
import {
  captureRemoteNativeProviderArtifacts,
  shareNativeProviderArtifactCapture,
} from "./native-provider-artifact-capture.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("shared provider artifact capture", () => {
  it("starts a capture at once when no capture for the same closure is in flight", async () => {
    const reuse = vi.fn(async () => "ready");
    const capture = vi.fn(async () => "captured");
    await expect(shareNativeProviderArtifactCapture({ key: `company:${Math.random()}`,
      signal: new AbortController().signal, reuse, capture })).resolves.toBe("captured");
    expect(capture).toHaveBeenCalledOnce();
    expect(reuse).not.toHaveBeenCalled();
  });

  it("lets concurrent first runs of one company share a single in-flight capture", async () => {
    const key = `company:${Math.random()}`;
    const leader = deferred<string>();
    let ready = false;
    const reuse = vi.fn(async () => ready ? "reused" : null);
    const capture = vi.fn(() => leader.promise);
    const runs = Array.from({ length: 8 }, () => shareNativeProviderArtifactCapture({
      key, signal: new AbortController().signal, reuse, capture }));
    await new Promise(resolve => setImmediate(resolve));
    expect(capture).toHaveBeenCalledOnce();
    ready = true;
    leader.resolve("captured");
    expect(await Promise.all(runs)).toEqual(["captured", ...Array(7).fill("reused")]);
    expect(capture).toHaveBeenCalledOnce();
  });

  it("captures again when the shared capture failed", async () => {
    const key = `company:${Math.random()}`;
    const leader = deferred<string>();
    const capture = vi.fn().mockImplementationOnce(() => leader.promise).mockResolvedValue("own");
    const reuse = vi.fn(async () => null);
    const first = shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture });
    const second = shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture });
    leader.reject(new Error("leader upload failed"));
    await expect(first).rejects.toThrow("leader upload failed");
    await expect(second).resolves.toBe("own");
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("starts a run's turn from another run's saved artifact while its own capture is still copying", async () => {
    const key = `company:${Math.random()}`;
    const hung = deferred<string>();
    const fast = deferred<string>();
    const signals: AbortSignal[] = [];
    let ready = false;
    const reuse = vi.fn(async () => ready ? "reused" : null);
    const capture = vi.fn()
      .mockImplementationOnce((signal: AbortSignal) => { signals.push(signal); return hung.promise; })
      .mockImplementationOnce((signal: AbortSignal) => { signals.push(signal); return fast.promise; });
    const slow = shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 10 });
    const other = shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 10 });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2), { interval: 1 });
    ready = true;
    fast.resolve("captured");
    await expect(other).resolves.toBe("captured");
    await expect(slow).resolves.toBe("reused");
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  it("uses a saved artifact when the run's own capture fails after another run saved one", async () => {
    const key = `company:${Math.random()}`;
    let ready = false;
    const reuse = vi.fn(async () => ready ? "reused" : null);
    const capture = vi.fn(async () => {
      ready = true;
      throw Object.assign(new Error('RPC call "environmentSyncOut" timed out after 330000ms'), { code: -32003 });
    });
    await expect(shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture }))
      .resolves.toBe("reused");
  });

  it("ends a still-running capture when another run's failed capture finds a saved copy", async () => {
    const key = `company:${Math.random()}`;
    const hung = deferred<string>();
    const signals: AbortSignal[] = [];
    let ready = false;
    const reuse = vi.fn(async () => ready ? "reused" : null);
    const capture = vi.fn()
      .mockImplementationOnce((signal: AbortSignal) => { signals.push(signal); return hung.promise; })
      .mockImplementationOnce(async () => {
        ready = true;
        throw new Error("copy failed after another server saved the files");
      });
    const slow = shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 10 });
    const failing = shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 10 });
    await expect(failing).resolves.toBe("reused");
    await expect(slow).resolves.toBe("reused");
    expect(signals[0]!.aborted).toBe(true);
  });

  it("ends the slow capture when a waiting run finds a copy another server saved", async () => {
    const key = `company:${Math.random()}`;
    const hung = deferred<string>();
    const signals: AbortSignal[] = [];
    let ready = false;
    const reuse = vi.fn(async () => ready ? "reused" : null);
    const capture = vi.fn().mockImplementationOnce((signal: AbortSignal) => { signals.push(signal); return hung.promise; });
    const slow = shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 10 });
    ready = true;
    const waiting = shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 10 });
    await expect(waiting).resolves.toBe("reused");
    await expect(slow).resolves.toBe("reused");
    expect(signals[0]!.aborted).toBe(true);
    expect(capture).toHaveBeenCalledOnce();
  });

  it("starts its own capture once instead of asking again when a saved copy cannot be reused", async () => {
    const key = `company:${Math.random()}`;
    const hung = deferred<string>();
    const reuse = vi.fn(async () => null);
    const capture = vi.fn()
      .mockImplementationOnce(() => hung.promise)
      .mockImplementationOnce(async () => "captured")
      .mockImplementationOnce(async () => "own");
    const slow = shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 10 });
    const hedge = shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 10 });
    await expect(hedge).resolves.toBe("captured");
    const late = shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 10 });
    await expect(late).resolves.toBe("own");
    expect(reuse.mock.calls.length).toBeLessThan(6);
    hung.resolve("late");
    await slow;
  });

  it("never runs more than two captures at once however many hedge windows pass", async () => {
    const key = `company:${Math.random()}`;
    const hung = deferred<string>();
    const hedge = deferred<string>();
    let ready = false;
    const reuse = vi.fn(async () => ready ? "reused" : null);
    const capture = vi.fn().mockImplementationOnce(() => hung.promise).mockImplementationOnce(() => hedge.promise);
    const runs = Array.from({ length: 6 }, () => shareNativeProviderArtifactCapture({
      key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 10 }));
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(capture).toHaveBeenCalledTimes(2);
    expect(reuse.mock.calls.length).toBeLessThan(20);
    ready = true;
    hedge.resolve("captured");
    expect((await Promise.all(runs)).sort()).toEqual(["captured", ...Array(5).fill("reused")]);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("keeps a stopped capture's slot until its copy out of the sandbox ends", async () => {
    const key = `company:${Math.random()}`;
    const transfer = deferred<void>();
    const stop = new AbortController();
    const reuse = vi.fn(async () => null);
    const pending = () => new Promise<string>(() => undefined);
    const capture = vi.fn()
      .mockImplementationOnce((signal: AbortSignal, hold: (work: Promise<unknown>) => void) => {
        hold(transfer.promise);
        return new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      })
      .mockImplementation(pending);
    const stopped = shareNativeProviderArtifactCapture({ key, signal: stop.signal, reuse, capture, hedgeAfterMs: 0 });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1), { interval: 1 });
    stop.abort(new Error("controlled Stop"));
    await expect(stopped).rejects.toThrow("controlled Stop");
    void shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 0 });
    void shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 0 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(capture).toHaveBeenCalledTimes(2);
    transfer.resolve();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(3), { interval: 1 });
  });

  it("keeps the two-capture cap for runs that cannot reuse the saved copy", async () => {
    const key = `company:${Math.random()}`;
    const releases: Array<() => void> = [];
    let active = 0, peak = 0;
    const reuse = vi.fn(async () => null);
    const capture = vi.fn((_signal: AbortSignal, hold: (work: Promise<unknown>) => void) => {
      const transfer = deferred<void>();
      active += 1;
      peak = Math.max(peak, active);
      hold(transfer.promise.finally(() => { active -= 1; }));
      releases.push(() => transfer.resolve());
      return capture.mock.calls.length === 2 ? Promise.resolve("captured") : new Promise<string>(() => undefined);
    });
    void shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 10 });
    await expect(shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 10 }))
      .resolves.toBe("captured");
    const misses = [0, 1].map(() => shareNativeProviderArtifactCapture({
      key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 10 }));
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(capture).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);
    releases[1]!();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(3), { interval: 1 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(capture).toHaveBeenCalledTimes(3);
    expect(peak).toBe(2);
    expect(reuse.mock.calls.length).toBeLessThan(12);
    releases.forEach(release => release());
    void misses;
  });

  it("starts one more capture when the shared capture runs past the hedge delay, not one per waiting run", async () => {
    const key = `company:${Math.random()}`;
    const hung = deferred<string>();
    const hedge = deferred<string>();
    let ready = false;
    const reuse = vi.fn(async () => ready ? "reused" : null);
    const capture = vi.fn().mockImplementationOnce(() => hung.promise).mockImplementationOnce(() => hedge.promise);
    const runs = Array.from({ length: 8 }, () => shareNativeProviderArtifactCapture({
      key, signal: new AbortController().signal, reuse, capture, hedgeAfterMs: 50 }));
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2), { interval: 1 });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(capture).toHaveBeenCalledTimes(2);
    ready = true;
    hedge.resolve("captured");
    expect((await Promise.all(runs)).sort()).toEqual(["captured", ...Array(7).fill("reused")]);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("does not start a capture per waiting run when the shared capture fails", async () => {
    const key = `company:${Math.random()}`;
    const leader = deferred<string>();
    const replacement = deferred<string>();
    let ready = false;
    const reuse = vi.fn(async () => ready ? "reused" : null);
    const capture = vi.fn().mockImplementationOnce(() => leader.promise).mockImplementationOnce(() => replacement.promise);
    const runs = Promise.allSettled(Array.from({ length: 6 }, () => shareNativeProviderArtifactCapture({
      key, signal: new AbortController().signal, reuse, capture })));
    leader.reject(new Error("leader copy failed"));
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2), { interval: 1 });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(capture).toHaveBeenCalledTimes(2);
    ready = true;
    replacement.resolve("captured");
    const settled = await runs;
    expect(settled.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("lets Stop end a wait for another run's capture", async () => {
    const key = `company:${Math.random()}`;
    const leader = deferred<string>();
    const stop = new AbortController();
    const capture = vi.fn(() => leader.promise);
    const reuse = vi.fn(async () => null);
    const first = shareNativeProviderArtifactCapture({ key, signal: new AbortController().signal, reuse, capture });
    const waiting = shareNativeProviderArtifactCapture({ key, signal: stop.signal, reuse, capture });
    stop.abort(new Error("controlled Stop"));
    await expect(waiting).rejects.toThrow("controlled Stop");
    leader.resolve("captured");
    await expect(first).resolves.toBe("captured");
    expect(capture).toHaveBeenCalledOnce();
  });
});

describe("provider artifact transfer step", () => {
  const runner = {
    execute: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null })),
    syncOut: vi.fn(async () => ({ operations: [] })),
  } as unknown as CommandManagedRuntimeRunner;
  const manifest = { payload: { artifacts: Object.fromEntries(["nodeCommand", "opencodeProxy", "opencodeExecutable"]
    .map(name => [name, { path: name }])) } } as NativeProviderArtifactSource["manifest"];
  const capture = (publish: (source: NativeProviderArtifactSource) => Promise<string>) => captureRemoteNativeProviderArtifacts({
    runner, remoteCwd: "/workspace", manifest, signal: new AbortController().signal,
    launch: { root: "/owned/qualified", accountUid: 1000,
      paths: { nodeCommand: "/qualified/node", opencodeProxy: "/qualified/proxy", opencodeExecutable: "/qualified/opencode" } },
  }, publish);

  it("retries a timed-out transfer without copying the launch files out of the sandbox again", async () => {
    const publish = vi.fn()
      .mockRejectedValueOnce(new NativeProviderArtifactTransferTimeoutError("upload", 120_000, 1024))
      .mockResolvedValue("receipt");
    vi.mocked(runner.syncOut!).mockClear();
    await expect(capture(publish)).resolves.toBe("receipt");
    expect(publish).toHaveBeenCalledTimes(2);
    expect(runner.syncOut).toHaveBeenCalledOnce();
  });

  it("fails with the transfer's own cause after the bounded attempts", async () => {
    const publish = vi.fn().mockRejectedValue(new NativeProviderArtifactTransferTimeoutError("download", 120_000, 1024));
    await expect(capture(publish)).rejects.toMatchObject({
      name: "NativeProviderArtifactTransferTimeoutError",
      code: "native_provider_artifacts_transfer_timeout",
      message: "native_provider_artifacts_transfer_timeout: the download of 1024 bytes did not finish within 120 s",
    });
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("names a stalled copy out of the sandbox instead of an unknown cause", async () => {
    vi.mocked(runner.syncOut!).mockRejectedValueOnce(new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
      message: 'RPC call "environmentSyncOut" timed out after 330000ms' }));
    const publish = vi.fn();
    const failure = await capture(publish).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "native_provider_artifacts_export_timeout" });
    expect(new NativeFailedBeforeProviderTurnError(null, failure)).toMatchObject({
      technicalCause: "native_provider_artifacts_export_timeout",
      message: "Setting up the computer took too long, so the task is continuing on a fresh one.",
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports the copy out of the sandbox as held work that outlives a Stop", async () => {
    const transfer = deferred<{ operations: [] }>();
    vi.mocked(runner.syncOut!).mockImplementationOnce(() => transfer.promise);
    const stop = new AbortController();
    const held: Promise<unknown>[] = [];
    const capturing = captureRemoteNativeProviderArtifacts({
      runner, remoteCwd: "/workspace", manifest, signal: stop.signal, hold: work => held.push(work),
      launch: { root: "/owned/qualified", accountUid: 1000,
        paths: { nodeCommand: "/qualified/node", opencodeProxy: "/qualified/proxy", opencodeExecutable: "/qualified/opencode" } },
    }, vi.fn());
    await vi.waitFor(() => expect(runner.syncOut).toHaveBeenCalled(), { interval: 1 });
    stop.abort(new Error("controlled Stop"));
    await expect(capturing).rejects.toThrow("controlled Stop");
    expect(held).toHaveLength(1);
    let settled = false;
    void held[0]!.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    transfer.resolve({ operations: [] });
    await vi.waitFor(() => expect(settled).toBe(true), { interval: 1 });
  });

  it("does not retry a failure that is not a transfer timeout", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("native_provider_artifacts_owner_changed"));
    await expect(capture(publish)).rejects.toThrow("native_provider_artifacts_owner_changed");
    expect(publish).toHaveBeenCalledOnce();
  });
});

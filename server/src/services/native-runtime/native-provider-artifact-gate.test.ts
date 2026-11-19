import { describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeProviderArtifactSource } from "./native-provider-artifacts.js";
import { NativeProviderArtifactTransferTimeoutError } from "./native-provider-artifacts.js";
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

  it("does not retry a failure that is not a transfer timeout", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("native_provider_artifacts_owner_changed"));
    await expect(capture(publish)).rejects.toThrow("native_provider_artifacts_owner_changed");
    expect(publish).toHaveBeenCalledOnce();
  });
});

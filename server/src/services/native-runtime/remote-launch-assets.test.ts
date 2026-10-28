import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { stageRemoteLaunchAssets } from "./remote-launch-assets.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { transport?: "sandbox" | "ssh"; concurrent?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "native-launch-assets-"));
  roots.push(root);
  mkdirSync(join(root, "codex-home"));
  writeFileSync(join(root, "codex-home", "auth.json"), "fresh test auth");
  writeFileSync(join(root, "codex-home", "config.toml"), "fresh test config");
  const calls: string[] = [];
  const source = nativeRuntimeContextFixture();
  const target = nativeRuntimeContextFixture();
  source.instructions.bundle.rootPath = join(root, "instructions");
  target.instructions.bundle.rootPath = "/session/filesystem/context/instructions";
  source.skills = [{ key: "test", runtimeName: "test", versionId: null, bundle: { ...source.instructions.bundle, rootPath: join(root, "skill") } }] as typeof source.skills;
  target.skills = [{ ...source.skills[0]!, bundle: { ...source.skills[0]!.bundle, rootPath: "/session/filesystem/context/skills/0-digest" } }];
  const stageFile = vi.fn(async (input: { sourcePath: string; targetPath: string; mode: number }) => {
    calls.push(`file:${input.targetPath}`);
  });
  const stageDirectory = vi.fn(async (input: { sourcePath: string; targetPath: string; mode: number }) => {
    calls.push(`directory:${input.targetPath}`);
  });
  const execute = vi.fn(async (_input: { command: string; args?: string[]; bypassSession?: boolean; timeoutMs?: number }) => {
    calls.push("mkdir:codex-home");
    return { exitCode: 0, signal: null, pid: null, startedAt: null, timedOut: false, stdout: "", stderr: "" };
  });
  const input: Parameters<typeof stageRemoteLaunchAssets>[0] = {
    root,
    transport: options.transport ?? "sandbox",
    runner: { execute, allowConcurrentSyncOperations: options.concurrent },
    persistenceDirectories: [{ name: "codex-home", location: "filesystem", targetPath: "/session/filesystem/codex-home" }],
    runtimeContext: { source, target, filesystemRoot: "/session/filesystem" },
    caBundleMapping: { sourcePath: join(root, "ca.pem"), targetPath: "/session/bin/ca.pem" },
    stageFile,
    stageDirectory,
  };
  return { input, root, calls, stageFile, stageDirectory, execute };
}

describe("remote launch asset staging", () => {
  it("retains serial paths, private launch modes and immutable context modes without an opt-in", async () => {
    const f = fixture();
    await stageRemoteLaunchAssets(f.input);
    expect(f.calls).toEqual([
      "mkdir:codex-home",
      "file:/session/filesystem/codex-home/auth.json",
      "file:/session/filesystem/codex-home/config.toml",
      "directory:/session/filesystem/context/instructions",
      "directory:/session/filesystem/context/skills/0-digest",
      "file:/session/filesystem/runtime-context.json",
      "file:/session/bin/ca.pem",
    ]);
    expect(f.stageFile.mock.calls.map(([input]) => input.mode)).toEqual([0o600, 0o600, 0o600, 0o600]);
    expect(f.stageDirectory.mock.calls.map(([input]) => input.mode)).toEqual([0o555, 0o555]);
    expect(f.execute.mock.calls[0]?.[0]).toMatchObject({ bypassSession: true, timeoutMs: 10_000 });
    expect(f.execute.mock.calls[0]?.[0]?.args?.[1]).toContain("install -d -m 0700");
    expect(readFileSync(f.stageFile.mock.calls[0]![0].sourcePath, "utf8")).toBe("fresh test auth");
  });

  it("stops serial staging before context and CA writes when launch material fails", async () => {
    const f = fixture();
    f.stageFile.mockRejectedValueOnce(new Error("launch failure"));
    await expect(stageRemoteLaunchAssets(f.input)).rejects.toThrow("launch failure");
    expect(f.stageDirectory).not.toHaveBeenCalled();
    expect(f.stageFile).toHaveBeenCalledTimes(1);
  });

  it("fails closed before any transfer when the persistence path is unavailable", async () => {
    const f = fixture();
    f.input.persistenceDirectories = [{ name: "codex-home", location: "filesystem", targetPath: null }];
    await expect(stageRemoteLaunchAssets(f.input)).rejects.toThrow("bootstrap_target_unavailable");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.stageDirectory).not.toHaveBeenCalled();
  });

  it("stops before CA staging when the immutable context fails", async () => {
    const f = fixture();
    f.stageDirectory.mockRejectedValueOnce(new Error("context failure"));
    await expect(stageRemoteLaunchAssets(f.input)).rejects.toThrow("context failure");
    expect(f.stageFile.mock.calls.map(([input]) => input.targetPath)).toEqual([
      "/session/filesystem/codex-home/auth.json", "/session/filesystem/codex-home/config.toml",
    ]);
  });

  it("does not require a context or launch credential files for preconfigured homes", async () => {
    const f = fixture();
    f.input.persistenceDirectories = [];
    f.input.runtimeContext = null;
    f.input.caBundleMapping = null;
    await stageRemoteLaunchAssets(f.input);
    expect(f.calls).toEqual([]);
  });

  it("overlaps disjoint launch material and context only with verified sandbox concurrency", async () => {
    const f = fixture({ concurrent: true });
    const started = deferred(), release = deferred();
    f.stageFile.mockImplementationOnce(async () => { started.resolve(); await release.promise; });
    const pending = stageRemoteLaunchAssets(f.input);
    await started.promise;
    try {
      expect(f.stageDirectory).toHaveBeenCalled();
      expect(f.stageFile.mock.calls.some(([input]) => input.targetPath === "/session/bin/ca.pem")).toBe(false);
    } finally { release.resolve(); await pending; }
    expect(f.calls.at(-1)).toBe("file:/session/bin/ca.pem");
  });

  it.each([
    { transport: "ssh" as const, concurrent: true },
    { transport: "sandbox" as const, concurrent: false },
    { transport: "sandbox" as const },
  ])("keeps unsupported transports serial: %j", async (options) => {
    const f = fixture(options);
    const started = deferred(), release = deferred();
    f.stageFile.mockImplementationOnce(async () => { started.resolve(); await release.promise; });
    const pending = stageRemoteLaunchAssets(f.input);
    await started.promise;
    try { expect(f.stageDirectory).not.toHaveBeenCalled(); }
    finally { release.resolve(); await pending; }
    expect(f.stageDirectory).toHaveBeenCalledTimes(2);
  });

  it("settles the context transfer before exposing a launch-material failure", async () => {
    const f = fixture({ concurrent: true });
    const contextStarted = deferred(), releaseContext = deferred();
    const failure = new Error("launch failed first");
    f.stageFile.mockRejectedValueOnce(failure);
    f.stageDirectory.mockImplementationOnce(async () => { contextStarted.resolve(); await releaseContext.promise; });
    let settled = false;
    let observed: unknown;
    const pending = stageRemoteLaunchAssets(f.input).then(() => { settled = true; }, error => { settled = true; observed = error; });
    await contextStarted.promise;
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally { releaseContext.resolve(); await pending; }
    expect(observed).toBe(failure);
    expect(f.stageFile.mock.calls.some(([input]) => input.targetPath === "/session/bin/ca.pem")).toBe(false);
  });

  it("settles launch material before exposing a context failure", async () => {
    const f = fixture({ concurrent: true });
    const launchStarted = deferred(), releaseLaunch = deferred();
    const failure = new Error("context failed first");
    f.stageFile.mockImplementationOnce(async () => { launchStarted.resolve(); await releaseLaunch.promise; });
    f.stageDirectory.mockRejectedValueOnce(failure);
    let settled = false;
    let observed: unknown;
    const pending = stageRemoteLaunchAssets(f.input).then(() => { settled = true; }, error => { settled = true; observed = error; });
    await launchStarted.promise;
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally { releaseLaunch.resolve(); await pending; }
    expect(observed).toBe(failure);
    expect(f.stageFile.mock.calls.some(([input]) => input.targetPath === "/session/bin/ca.pem")).toBe(false);
  });

  it("retains launch-material error priority when both parallel transfers fail", async () => {
    const f = fixture({ concurrent: true });
    const failure = new Error("launch priority");
    f.stageFile.mockRejectedValueOnce(failure);
    f.stageDirectory.mockRejectedValueOnce(new Error("context failure"));
    await expect(stageRemoteLaunchAssets(f.input)).rejects.toBe(failure);
    expect(f.stageDirectory).toHaveBeenCalledOnce();
  });
});

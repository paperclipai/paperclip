import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
} = vi.hoisted(() => ({
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({
    stdout: Buffer.from('{"token":"remote"}\n').toString("base64"),
    stderr: "",
  })),
  syncDirectoryToSsh: vi.fn(async (_input: { localDir: string }) => undefined),
}));

vi.mock("./ssh.js", () => ({
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
}));

import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { resolveReferencedSourceIgnore } from "./sandbox-managed-runtime.js";
import { setExpensiveWorkspaceGitExecutor } from "./git-workspace-sync.js";

describe("remote managed runtime", () => {
  const cleanupDirs: string[] = [];

  it("stages all files over SSH without Git or cache exclusions and restores the same baseline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-plain-"));
    cleanupDirs.push(root);
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
    await writeFile(path.join(root, "node_modules", "personal.bin"), Buffer.from([0, 255, 1]));
    const prepared = await prepareRemoteManagedRuntime({
      spec: { host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app", remoteCwd: "/app",
        privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS", strictHostKeyChecking: true },
      runId: "plain", adapterKey: "test", workspaceLocalDir: root,
      workspaceFileMode: "all", workspaceExclude: ["explicitly-excluded"],
    });
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: root, remoteDir: prepared.workspaceRemoteDir, workspaceFileMode: "all", workspaceExclude: ["explicitly-excluded"],
    }));
    await prepared.restoreWorkspace();
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      restoreGitHistory: false, baselineSnapshot: expect.objectContaining({
        exclude: [".paperclip-runtime", "explicitly-excluded"],
        entries: expect.any(Map),
      }),
    }));
    const args = vi.mocked(restoreWorkspaceFromSshExecution).mock.calls[0] as unknown as [{ baselineSnapshot: { entries: Map<string, unknown> } }];
    expect(args[0].baselineSnapshot.entries.has("node_modules/personal.bin")).toBe(true);
  });


  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("restores runtime assets without restoring an in-place SSH workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-assets-only-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const homeDir = path.join(rootDir, "home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(path.join(homeDir, "auth.json"), '{"token":"host"}\n', "utf8");

    let restoredAuth = "";
    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-in-place",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      assets: [
        {
          key: "home",
          localDir: homeDir,
          restore: async ({ assetDir, readFile }) => {
            restoredAuth = (await readFile(path.posix.join(assetDir, "auth.json"))).toString("utf8");
          },
        },
      ],
    });

    expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: homeDir,
      remoteDir: "/app/.paperclip-runtime/runs/run-in-place/codex/home",
    }));

    await prepared.restoreWorkspace();

    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      "base64 < '/app/.paperclip-runtime/runs/run-in-place/codex/home/auth.json'",
      { maxBuffer: 1024 * 1024 },
    );
    expect(restoredAuth).toBe('{"token":"remote"}\n');
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      "rm -rf -- '/app/.paperclip-runtime/runs/run-in-place/codex'",
      { maxBuffer: 1024 * 1024 },
    );
  });

  it("stages concurrent in-place SSH runtime assets in distinct run-scoped directories", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-concurrent-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const homeDir = path.join(rootDir, "home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });

    const remoteDirs: string[] = [];
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    syncDirectoryToSsh.mockImplementation(async (input: { localDir: string; remoteDir?: string }) => {
      if (!input.remoteDir) throw new Error("expected remoteDir");
      remoteDirs.push(input.remoteDir);
      if (remoteDirs.length === 2) releaseBoth();
      await bothStarted;
    });

    const common = {
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      assets: [{ key: "home", localDir: homeDir }],
    };

    const [first, second] = await Promise.all([
      prepareRemoteManagedRuntime({ ...common, runId: "run-a" }),
      prepareRemoteManagedRuntime({ ...common, runId: "run-b" }),
    ]);

    expect(first.runtimeRootDir).toBe("/app/.paperclip-runtime/runs/run-a/codex");
    expect(second.runtimeRootDir).toBe("/app/.paperclip-runtime/runs/run-b/codex");
    expect(first.assetDirs.home).not.toBe(second.assetDirs.home);
    expect(new Set(remoteDirs)).toEqual(new Set([
      "/app/.paperclip-runtime/runs/run-a/codex/home",
      "/app/.paperclip-runtime/runs/run-b/codex/home",
    ]));
  });

  it("removes the run-scoped runtime when in-place asset restoration fails", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-restore-failure-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const homeDir = path.join(rootDir, "home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-restore-failed",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      assets: [{
        key: "home",
        localDir: homeDir,
        restore: async () => {
          throw new Error("fixture restore failed");
        },
      }],
    });

    await expect(prepared.restoreWorkspace()).rejects.toThrow("fixture restore failed");
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      "rm -rf -- '/app/.paperclip-runtime/runs/run-restore-failed/codex'",
      { maxBuffer: 1024 * 1024 },
    );
  });

  it("does not replace a successful restoration result when runtime cleanup fails", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-cleanup-failure-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const homeDir = path.join(rootDir, "home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    runSshCommand.mockRejectedValueOnce(new Error("fixture cleanup failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-cleanup-failed",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      assets: [{ key: "home", localDir: homeDir }],
    });

    await expect(prepared.restoreWorkspace()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("run-cleanup-failed"));
    warnSpy.mockRestore();
  });

  it("preserves the restoration error when runtime cleanup also fails", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-double-failure-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const homeDir = path.join(rootDir, "home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    runSshCommand.mockRejectedValueOnce(new Error("fixture cleanup failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-double-failed",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      assets: [{
        key: "home",
        localDir: homeDir,
        restore: async () => {
          throw new Error("fixture restore failed first");
        },
      }],
    });

    await expect(prepared.restoreWorkspace()).rejects.toThrow("fixture restore failed first");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("run-double-failed"));
    warnSpy.mockRestore();
  });

  it("rejects a run id that could escape its run-scoped directory", async () => {
    await expect(prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "../escape",
      adapterKey: "codex",
      workspaceLocalDir: "/local/workspace",
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
    })).rejects.toThrow("runId is not a simple path segment");
    expect(syncDirectoryToSsh).not.toHaveBeenCalled();
    expect(runSshCommand).not.toHaveBeenCalled();
  });

  it("rejects an in-place persistence path that could escape before transfer", async () => {
    await expect(prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-safe",
      adapterKey: "codex",
      workspaceLocalDir: "/local/workspace",
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      assets: [{
        key: "home",
        localDir: "/local/home",
        inPlaceSshPersistence: { scope: "agent-1", directories: ["../sessions"] },
      }],
    })).rejects.toThrow("in-place SSH persistent directory is not a simple path segment");
    expect(syncDirectoryToSsh).not.toHaveBeenCalled();
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      "rm -rf -- '/app/.paperclip-runtime/runs/run-safe/codex'",
      { maxBuffer: 1024 * 1024 },
    );
  });

  it("removes a partial run-scoped runtime after in-place SSH asset staging fails", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-failure-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const homeDir = path.join(rootDir, "home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    syncDirectoryToSsh.mockRejectedValueOnce(new Error("fixture extraction collision"));

    await expect(prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-failed",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      assets: [{ key: "home", localDir: homeDir }],
    })).rejects.toThrow("fixture extraction collision");

    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      "rm -rf -- '/app/.paperclip-runtime/runs/run-failed/codex'",
      { maxBuffer: 1024 * 1024 },
    );
  });

  it("stages each additional project into its own isolated SSH dir, isolating one failure", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-additional-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const firstDir = path.join(rootDir, "referenced-first");
    const secondDir = path.join(rootDir, "referenced-second");
    const brokenDir = path.join(rootDir, "referenced-broken");
    await mkdir(workspaceDir, { recursive: true });

    // The transfer rejects only for the broken project's directory.
    syncDirectoryToSsh.mockImplementation(async (input: { localDir: string }) => {
      if (input.localDir === brokenDir) throw new Error("ssh transfer failed");
      return undefined;
    });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-additional",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: firstDir, projectId: "first", ignoreResolution: { kind: "other" } },
        { localPath: brokenDir, projectId: "broken", ignoreResolution: { kind: "other" } },
        { localPath: secondDir, projectId: "second", ignoreResolution: { kind: "other" } },
      ],
    });

    // Each healthy project staged into its OWN isolated dir under the runtime
    // root; the broken one is skipped, not fatal.
    expect(Object.keys(prepared.additionalSourceDirs).sort()).toEqual(["first", "second"]);
    expect(prepared.additionalSourceDirs.first).toBe("/app/.paperclip-runtime/runs/run-additional/codex/project-first");
    expect(prepared.additionalSourceDirs.second).toBe("/app/.paperclip-runtime/runs/run-additional/codex/project-second");
    expect(prepared.additionalSourceDirs.broken).toBeUndefined();
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: firstDir,
      remoteDir: "/app/.paperclip-runtime/runs/run-additional/codex/project-first",
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: secondDir,
      remoteDir: "/app/.paperclip-runtime/runs/run-additional/codex/project-second",
    }));
  });

  it("skips an additional project whose localPath is not absolute", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-relative-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const healthyDir = path.join(rootDir, "referenced-healthy");
    await mkdir(workspaceDir, { recursive: true });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-relative",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: "relative/referenced", projectId: "relative", ignoreResolution: { kind: "other" } },
        { localPath: healthyDir, projectId: "healthy", ignoreResolution: { kind: "other" } },
      ],
    });

    // The relative-path project never reaches the transfer and is skipped; the
    // absolute-path project still stages.
    expect(Object.keys(prepared.additionalSourceDirs)).toEqual(["healthy"]);
    expect(syncDirectoryToSsh).not.toHaveBeenCalledWith(expect.objectContaining({
      localDir: "relative/referenced",
    }));
  });

  it("passes a project's resolved Git-ignored paths to the SSH exclude list, escaped", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-ignore-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const projectDir = path.join(rootDir, "referenced-project");
    await mkdir(workspaceDir, { recursive: true });

    await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-ignore",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        {
          localPath: projectDir,
          projectId: "proj",
          ignoreResolution: { kind: "git", ignoredPaths: ["secret.env", "build", "weird[1].txt"] },
        },
      ],
    });

    const call = syncDirectoryToSsh.mock.calls.find((entry) => entry[0].localDir === projectDir);
    expect(call).toBeDefined();
    const exclude = (call![0] as { exclude?: string[] }).exclude ?? [];
    // The resolved ignored paths ride the exclude list, glob-escaped, on top of
    // the fixed heavy-directory excludes the SSH lane already applies.
    expect(exclude).toContain("secret.env");
    expect(exclude).toContain("build");
    expect(exclude).toContain("weird\\[1].txt");
    expect(exclude).toContain("node_modules");
  });

  it("skips a project whose ignore resolution failed without ever calling syncDirectoryToSsh for it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-failed-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const healthyDir = path.join(rootDir, "referenced-healthy");
    const failedDir = path.join(rootDir, "referenced-failed");
    await mkdir(workspaceDir, { recursive: true });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-failed",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: healthyDir, projectId: "healthy", ignoreResolution: { kind: "other" } },
        { localPath: failedDir, projectId: "failed", ignoreResolution: { kind: "failed", reason: "git status timed out" } },
      ],
    });

    // Fail closed: the failed project never reaches the transfer at all — no
    // bytes are sent for it — while the healthy project still stages.
    expect(Object.keys(prepared.additionalSourceDirs)).toEqual(["healthy"]);
    expect(syncDirectoryToSsh).not.toHaveBeenCalledWith(expect.objectContaining({ localDir: failedDir }));
  });

  it("never leaks a raw absolute path into the remote per-project staging warning", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-redact-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const failedDir = path.join(rootDir, "referenced-failed");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(failedDir, { recursive: true });

    // A raw toplevel string that makes `failedDir` a non-descendant, carrying
    // a sensitive absolute path — exactly the shape a caught Git diagnostic
    // could embed. `resolveReferencedSourceIgnore` is the single choke point
    // that must reduce it to the fixed category before anything downstream
    // (here, the remote lane's warning) ever sees it.
    const sensitivePath = "/srv/alice/project";
    let ignoreResolution;
    try {
      setExpensiveWorkspaceGitExecutor(async (input) => {
        if (input.operation === "referenced_source.toplevel") {
          return { stdout: `${sensitivePath}\n`, stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      ignoreResolution = await resolveReferencedSourceIgnore(failedDir);
    } finally {
      setExpensiveWorkspaceGitExecutor(null);
    }
    expect(ignoreResolution.kind).toBe("failed");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await prepareRemoteManagedRuntime({
        spec: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/app",
          remoteCwd: "/app",
          privateKey: "PRIVATE KEY",
          knownHosts: "KNOWN HOSTS",
          strictHostKeyChecking: true,
        },
        runId: "run-redact",
        adapterKey: "codex",
        workspaceLocalDir: workspaceDir,
        workspaceRemoteDir: "/app",
        syncWorkspace: false,
        additionalSources: [{ localPath: failedDir, projectId: "failed", ignoreResolution }],
      });

      const warnedText = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(warnedText).toContain("failed");
      expect(warnedText).not.toContain(sensitivePath);
      expect(warnedText).not.toContain(failedDir);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

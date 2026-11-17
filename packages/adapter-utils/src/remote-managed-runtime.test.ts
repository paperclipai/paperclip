import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  runSshCommand: vi.fn(async (_spec?: unknown, _command?: string, _options?: unknown) => ({
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
    runSshCommand.mockReset().mockResolvedValue({ stdout: Buffer.from('{"token":"remote"}\n').toString("base64"), stderr: "" });
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("isolates managed credentials for overlapping in-place SSH runs and removes each private runtime after copy-back", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-credentials-"));
    cleanupDirs.push(rootDir);
    const homeDir = path.join(rootDir, "selected-account");
    await mkdir(homeDir);
    await writeFile(path.join(homeDir, "auth.json"), '{"account":"selected-agent"}');
    runSshCommand.mockResolvedValueOnce({ stdout: "/tmp/paperclip-ssh-runtime.first\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "/tmp/paperclip-ssh-runtime.second\n", stderr: "" });
    const restore = vi.fn(async () => {});
    const input = {
      spec: { host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app", remoteCwd: "/app", privateKey: null, knownHosts: null, strictHostKeyChecking: true },
      runId: "first", adapterKey: "codex", workspaceLocalDir: rootDir, syncWorkspace: false, privateRuntime: true,
      assets: [{ key: "home", localDir: homeDir, restore }],
    };
    const first = await prepareRemoteManagedRuntime(input);
    const second = await prepareRemoteManagedRuntime({ ...input, runId: "second" });
    expect(first.runtimeRootDir).toBe("/tmp/paperclip-ssh-runtime.first");
    expect(second.runtimeRootDir).toBe("/tmp/paperclip-ssh-runtime.second");
    expect(first.assetDirs.home).not.toBe(second.assetDirs.home);
    await Promise.all([first.restoreWorkspace(), first.restoreWorkspace()]);
    await first.restoreWorkspace();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ assetDir: "/tmp/paperclip-ssh-runtime.first/home" }));
    expect(runSshCommand).toHaveBeenCalledWith(expect.anything(), "rm -rf -- '/tmp/paperclip-ssh-runtime.first'", expect.anything());
    expect(runSshCommand.mock.calls.some(call => call[1] === "rm -rf -- '/tmp/paperclip-ssh-runtime.second'")).toBe(false);
    expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
    await second.restoreWorkspace();
  });

  it("retains an ACP credential home across turns until its session owner disposes it", async () => {
    runSshCommand.mockResolvedValueOnce({ stdout: "/tmp/paperclip-ssh-runtime.retained\n", stderr: "" });
    const restore = vi.fn(async () => {});
    const runtime = await prepareRemoteManagedRuntime({
      spec: { host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app", remoteCwd: "/app", privateKey: null, knownHosts: null, strictHostKeyChecking: true },
      runId: "retained", adapterKey: "codex", workspaceLocalDir: "/unused", syncWorkspace: false,
      privateRuntime: true, retainRuntime: true, assets: [{ key: "home", localDir: "/fixture", restore }],
    });
    await runtime.restoreWorkspace();
    await runtime.restoreWorkspace();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(runSshCommand).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("rm -rf"), expect.anything());
    await runtime.disposeRuntime();
    await runtime.disposeRuntime();
    expect(runSshCommand.mock.calls.filter(call => call[1]?.includes("rm -rf"))).toHaveLength(1);
  });

  it.each(["staging", "refresh"])("removes a private credential home after a %s failure", async phase => {
    runSshCommand.mockResolvedValueOnce({ stdout: "/tmp/paperclip-ssh-runtime.failed\n", stderr: "" });
    if (phase === "staging") syncDirectoryToSsh.mockRejectedValueOnce(new Error("staging failed"));
    const prepare = prepareRemoteManagedRuntime({
      spec: { host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app", remoteCwd: "/app", privateKey: null, knownHosts: null, strictHostKeyChecking: true },
      runId: "failed", adapterKey: "codex", workspaceLocalDir: "/unused", syncWorkspace: false, privateRuntime: true,
      assets: [{ key: "home", localDir: "/fixture", restore: async () => { throw new Error("refresh failed"); } }],
    });
    if (phase === "staging") await expect(prepare).rejects.toThrow("staging failed");
    else await expect((await prepare).restoreWorkspace()).rejects.toThrow("refresh failed");
    expect(runSshCommand).toHaveBeenCalledWith(expect.anything(), "rm -rf -- '/tmp/paperclip-ssh-runtime.failed'", expect.anything());
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
      remoteDir: "/app/.paperclip-runtime/codex/home",
    }));

    await prepared.restoreWorkspace();

    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("base64 < '/app/.paperclip-runtime/codex/home/auth.json'"),
      { maxBuffer: 1024 * 1024 },
    );
    expect(restoredAuth).toBe('{"token":"remote"}\n');
  });

  it.each(["missing", "missing with SSH warning", "present", "read failure", "connection failure"])(
    "preserves SSH file-read error semantics for %s files",
    async outcome => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-file-read-"));
      cleanupDirs.push(root);
      const remoteCwd = path.join(root, "remote's workspace");
      const assetDir = path.join(remoteCwd, ".paperclip-runtime", "codex", "home");
      await mkdir(assetDir, { recursive: true });
      const content = Buffer.from([0, 255, 1, 10]);
      if (!outcome.startsWith("missing")) await writeFile(path.join(assetDir, "auth.json"), content);
      const transportError = Object.assign(new Error("fixture SSH connection failed"), { code: 255 });
      runSshCommand.mockImplementationOnce(async (_spec, command) => {
        if (outcome === "connection failure") throw transportError;
        const script = outcome === "read failure"
          ? `base64() { printf '%s\\n' 'fixture read failure' >&2; return 44; }; ${command}`
          : outcome === "missing with SSH warning"
            ? `printf '%s\\n' 'fixture SSH host-key warning' >&2; ${command}`
            : command!;
        return promisify(execFile)("sh", ["-c", script!]);
      });
      let bytes: Buffer | undefined;
      const prepared = await prepareRemoteManagedRuntime({
        spec: { host: "ssh.example.test", port: 22, username: "agent", remoteWorkspacePath: remoteCwd,
          remoteCwd, privateKey: null, knownHosts: null, strictHostKeyChecking: true },
        runId: "read-file", adapterKey: "codex", workspaceLocalDir: root, workspaceRemoteDir: remoteCwd,
        syncWorkspace: false,
        assets: [{ key: "home", localDir: root, restore: async ({ assetDir, readFile }) => {
          bytes = await readFile(path.posix.join(assetDir, "auth.json"));
        } }],
      });
      if (outcome === "present") {
        await prepared.restoreWorkspace();
        expect(bytes).toEqual(content);
      } else if (outcome.startsWith("missing")) {
        await expect(prepared.restoreWorkspace()).rejects.toMatchObject({ code: "ENOENT" });
      } else if (outcome === "connection failure") {
        await expect(prepared.restoreWorkspace()).rejects.toBe(transportError);
      } else {
        await expect(prepared.restoreWorkspace()).rejects.toMatchObject({ code: 44, stderr: "fixture read failure\n" });
      }
    },
  );

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
    expect(prepared.additionalSourceDirs.first).toBe("/app/.paperclip-runtime/codex/project-first");
    expect(prepared.additionalSourceDirs.second).toBe("/app/.paperclip-runtime/codex/project-second");
    expect(prepared.additionalSourceDirs.broken).toBeUndefined();
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: firstDir,
      remoteDir: "/app/.paperclip-runtime/codex/project-first",
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: secondDir,
      remoteDir: "/app/.paperclip-runtime/codex/project-second",
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

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      remoteDir: "/app/.paperclip-runtime/codex/home",
    }));

    await prepared.restoreWorkspace();

    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      "base64 < '/app/.paperclip-runtime/codex/home/auth.json'",
      { maxBuffer: 1024 * 1024 },
    );
    expect(restoredAuth).toBe('{"token":"remote"}\n');
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

describe("remote managed runtime — stable task workspace", () => {
  const cleanupDirs: string[] = [];
  const spec = {
    host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app", remoteCwd: "/app",
    privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS", strictHostKeyChecking: true,
  } as const;
  const identity = { companyId: "co-1", agentId: "agent-1", issueId: "issue-1" };

  beforeEach(async () => {
    vi.clearAllMocks();
    prepareWorkspaceForSshExecution.mockImplementation(async () => ({ gitBacked: false }));
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-stable-task-lockroot-"));
    cleanupDirs.push(root);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "stable-task-test");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeWorkspaceDir() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-stable-task-ws-"));
    cleanupDirs.push(root);
    return root;
  }

  it("realizes the workspace at the stable per-task directory", async () => {
    const workspaceDir = await makeWorkspaceDir();
    const prepared = await prepareRemoteManagedRuntime({
      spec, runId: "run-a", adapterKey: "opencode", workspaceLocalDir: workspaceDir,
      taskWorkspace: identity,
    });
    expect(prepared.workspaceRemoteDir).toBe(
      "/app/.paperclip-runtime/tasks/co-1/agent-1/issue-1/workspace",
    );
    expect(prepared.runtimeRootDir).toBe(
      "/app/.paperclip-runtime/tasks/co-1/agent-1/issue-1/workspace/.paperclip-runtime/opencode",
    );
    expect(prepared.taskWorkspaceIdentity).toEqual(identity);
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: "/app/.paperclip-runtime/tasks/co-1/agent-1/issue-1/workspace",
    }));
    await prepared.restoreWorkspace();
  });

  it("keeps the legacy per-run directory without task identity", async () => {
    const workspaceDir = await makeWorkspaceDir();
    const prepared = await prepareRemoteManagedRuntime({
      spec, runId: "run-legacy", adapterKey: "opencode", workspaceLocalDir: workspaceDir,
    });
    expect(prepared.workspaceRemoteDir).toBe("/app/.paperclip-runtime/runs/run-legacy/workspace");
    expect(prepared.taskWorkspaceIdentity).toBeNull();
    await prepared.restoreWorkspace();
  });

  it("rejects identity segments that are not simple path segments", async () => {
    const workspaceDir = await makeWorkspaceDir();
    await expect(prepareRemoteManagedRuntime({
      spec, runId: "run-bad", adapterKey: "opencode", workspaceLocalDir: workspaceDir,
      taskWorkspace: { companyId: "co/../escape", agentId: "agent-1", issueId: "issue-1" },
    })).rejects.toThrow(/simple path segment/);
    await expect(prepareRemoteManagedRuntime({
      spec, runId: "run-bad", adapterKey: "opencode", workspaceLocalDir: workspaceDir,
      taskWorkspace: { companyId: "co-1", agentId: "agent/1", issueId: "issue-1" },
    })).rejects.toThrow(/simple path segment/);
    await expect(prepareRemoteManagedRuntime({
      spec, runId: "run-bad", adapterKey: "opencode", workspaceLocalDir: workspaceDir,
      taskWorkspace: { companyId: "co-1", agentId: "agent-1", issueId: "  " },
    })).rejects.toThrow(/simple path segment/);
    expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
  });

  it("serializes concurrent cycles of the same task and fails fast", async () => {
    const workspaceDir = await makeWorkspaceDir();
    // No initializer: an initialized `null` stays narrowed to `null` across the
    // awaits and makes the optional call below fail to typecheck (TS2349).
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    prepareWorkspaceForSshExecution.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await firstGate;
      return { gitBacked: false };
    });
    const first = prepareRemoteManagedRuntime({
      spec, runId: "run-first", adapterKey: "opencode", workspaceLocalDir: workspaceDir,
      taskWorkspace: identity,
    });
    await vi.waitFor(() => {
      expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    });
    await expect(prepareRemoteManagedRuntime({
      spec, runId: "run-second", adapterKey: "opencode", workspaceLocalDir: workspaceDir,
      taskWorkspace: identity,
      taskWorkspaceLockWaitMs: 150,
    })).rejects.toMatchObject({ code: "ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT" });
    releaseFirst?.();
    const prepared = await first;
    await prepared.restoreWorkspace();
  });

  it("releases the cycle lock when preparation fails", async () => {
    const workspaceDir = await makeWorkspaceDir();
    prepareWorkspaceForSshExecution.mockImplementation(async () => {
      throw new Error("ssh transport failed");
    });
    await expect(prepareRemoteManagedRuntime({
      spec, runId: "run-err", adapterKey: "opencode", workspaceLocalDir: workspaceDir,
      taskWorkspace: identity,
    })).rejects.toThrow("ssh transport failed");
    prepareWorkspaceForSshExecution.mockImplementation(async () => ({ gitBacked: false }));
    const prepared = await prepareRemoteManagedRuntime({
      spec, runId: "run-retry", adapterKey: "opencode", workspaceLocalDir: workspaceDir,
      taskWorkspace: identity,
      taskWorkspaceLockWaitMs: 150,
    });
    await prepared.restoreWorkspace();
  });

  it("releases the cycle lock after restore and stays idempotent", async () => {
    const workspaceDir = await makeWorkspaceDir();
    const first = await prepareRemoteManagedRuntime({
      spec, runId: "run-r1", adapterKey: "opencode", workspaceLocalDir: workspaceDir,
      taskWorkspace: identity,
    });
    await first.restoreWorkspace();
    await first.restoreWorkspace();
    const second = await prepareRemoteManagedRuntime({
      spec, runId: "run-r2", adapterKey: "opencode", workspaceLocalDir: workspaceDir,
      taskWorkspace: identity,
      taskWorkspaceLockWaitMs: 150,
    });
    expect(second.workspaceRemoteDir).toBe(first.workspaceRemoteDir);
    await second.restoreWorkspace();
  });

  it("allows a different task of the same agent to prepare concurrently", async () => {
    const workspaceDirA = await makeWorkspaceDir();
    const workspaceDirB = await makeWorkspaceDir();
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    prepareWorkspaceForSshExecution.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { gitBacked: false };
    });
    const first = prepareRemoteManagedRuntime({
      spec, runId: "run-t1", adapterKey: "opencode", workspaceLocalDir: workspaceDirA,
      taskWorkspace: identity,
    });
    await vi.waitFor(() => {
      expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    });
    const second = await prepareRemoteManagedRuntime({
      spec, runId: "run-t2", adapterKey: "opencode", workspaceLocalDir: workspaceDirB,
      taskWorkspace: { ...identity, issueId: "issue-2" },
      taskWorkspaceLockWaitMs: 150,
    });
    releaseFirst?.();
    const preparedFirst = await first;
    await preparedFirst.restoreWorkspace();
    await second.restoreWorkspace();
  });
});

import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
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

import { prepareRemoteManagedRuntime, removeStableSshWorkspaceFolder } from "./remote-managed-runtime.js";
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

describe("stable remote workspace folder", () => {
  const WS_ID = "11111111-2222-4333-8444-555555555555";
  const spec = {
    host: "192.0.2.10", port: 22, username: "fixture", remoteWorkspacePath: "/app", remoteCwd: "/app",
    privateKey: null, knownHosts: null, strictHostKeyChecking: true,
  };
  const stable = { ...spec, remoteWorkspaceKey: "execution_workspace" as const };
  const lockCommands = () => runSshCommand.mock.calls.map((call) => String((call as unknown[])[1]));
  let localDir = "";

  async function setup(sshImpl: (command: string) => string) {
    localDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-stable-"));
    runSshCommand.mockImplementation((async (_spec: unknown, command: string) => ({ stdout: sshImpl(command), stderr: "" })) as never);
  }

  afterEach(async () => {
    runSshCommand.mockImplementation((async () => ({ stdout: "", stderr: "" })) as never);
    vi.clearAllMocks();
    await rm(localDir, { recursive: true, force: true });
  });

  it("keeps per-run paths byte-identical by default", async () => {
    await setup(() => "ACQUIRED\n");
    const prepared = await prepareRemoteManagedRuntime({
      spec, runId: "run-a", adapterKey: "x", workspaceLocalDir: localDir, executionWorkspaceId: WS_ID,
    });
    expect(prepared.workspaceRemoteDir).toBe("/app/.paperclip-runtime/runs/run-a/workspace");
    expect(prepared.runtimeRootDir).toBe("/app/.paperclip-runtime/runs/run-a/workspace/.paperclip-runtime/x");
    expect(lockCommands().some((command) => command.includes("mkdir"))).toBe(false);
  });

  it("uses one folder per execution workspace and per-run runtime assets, and releases the lock on restore", async () => {
    await setup(() => "ACQUIRED\n");
    const prepared = await prepareRemoteManagedRuntime({
      spec: stable, runId: "run-a", adapterKey: "x", workspaceLocalDir: localDir, executionWorkspaceId: WS_ID,
    });
    expect(prepared.workspaceRemoteDir).toBe(`/app/.paperclip-runtime/workspaces/${WS_ID}/workspace`);
    expect(prepared.runtimeRootDir).toBe("/app/.paperclip-runtime/runs/run-a/runtime/x");
    expect(lockCommands().some((command) => command.includes(`workspaces/${WS_ID}/lock`))).toBe(true);
    await prepared.restoreWorkspace();
    const release = lockCommands().find((command) => command.includes("grep -qx") && command.includes("runId=run-a"));
    expect(release).toContain("rm -rf");
    // The release is the last step, after the marker write and the run-folder cleanup.
    expect(lockCommands().at(-1)).toBe(release);
  });

  it.each([undefined, null, "", "../etc", "a/b", "not-a-uuid"])("falls back to the per-run folder for id %j", async (id) => {
    await setup(() => "ACQUIRED\n");
    const prepared = await prepareRemoteManagedRuntime({
      spec: stable, runId: "run-a", adapterKey: "x", workspaceLocalDir: localDir, executionWorkspaceId: id,
    });
    expect(prepared.workspaceRemoteDir).toBe("/app/.paperclip-runtime/runs/run-a/workspace");
  });

  it("falls back to the per-run folder and logs when a live run holds the lock", async () => {
    await setup((command) => (command.includes("mkdir") ? "BUSY\nrunId=run-live\nstartedAt=" + Date.now() + "\n" : ""));
    const progress: string[] = [];
    const prepared = await prepareRemoteManagedRuntime({
      spec: { ...stable, isRunActive: async () => true }, runId: "run-b", adapterKey: "x",
      workspaceLocalDir: localDir, executionWorkspaceId: WS_ID, onProgress: (line) => void progress.push(line),
    });
    expect(prepared.workspaceRemoteDir).toBe("/app/.paperclip-runtime/runs/run-b/workspace");
    expect(progress.join("")).toContain("stable remote folder busy (owner run-live); using per-run folder");
    await prepared.restoreWorkspace();
    // This run never held the lock, so it never releases it.
    expect(lockCommands().some((command) => command.includes("grep -qx"))).toBe(false);
  });

  it("takes over a lock whose owner run is terminal", async () => {
    let mkdirs = 0;
    await setup((command) => (command.includes("mkdir") ? (mkdirs++ === 0 ? "BUSY\nrunId=run-dead\nstartedAt=" + Date.now() + "\n" : "ACQUIRED\n") : ""));
    const prepared = await prepareRemoteManagedRuntime({
      spec: { ...stable, isRunActive: async (runId) => runId !== "run-dead" }, runId: "run-b", adapterKey: "x",
      workspaceLocalDir: localDir, executionWorkspaceId: WS_ID,
    });
    expect(prepared.workspaceRemoteDir).toBe(`/app/.paperclip-runtime/workspaces/${WS_ID}/workspace`);
  });

  it("without a run lookup, takes over only a lock older than the timeout plus 30 minutes", async () => {
    const owner = (ageMs: number) => `BUSY\nrunId=run-old\nstartedAt=${Date.now() - ageMs}\n`;
    let mkdirs = 0;
    await setup((command) => (command.includes("mkdir") ? (mkdirs++ === 0 ? owner(31 * 60_000 + 60_000) : "ACQUIRED\n") : ""));
    const stale = await prepareRemoteManagedRuntime({
      spec: stable, runId: "run-b", adapterKey: "x", workspaceLocalDir: localDir, executionWorkspaceId: WS_ID, timeoutSec: 60,
    });
    expect(stale.workspaceRemoteDir).toContain(`/workspaces/${WS_ID}/`);

    await setup((command) => (command.includes("mkdir") ? owner(10 * 60_000) : ""));
    const fresh = await prepareRemoteManagedRuntime({
      spec: stable, runId: "run-c", adapterKey: "x", workspaceLocalDir: localDir, executionWorkspaceId: WS_ID, timeoutSec: 60,
    });
    expect(fresh.workspaceRemoteDir).toBe("/app/.paperclip-runtime/runs/run-c/workspace");
  });

  it("lets only one of two runs take over the same stale lock", async () => {
    // Stateful stand-in for the remote lock dir: mkdir fails while it exists, the reap command is
    // atomic and only replaces the lock while its owner is still the one the caller observed.
    let owner: string | null = "run-dead";
    let reapHeld = false;
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    let removals = 0;
    await setup(() => "");
    runSshCommand.mockImplementation((async (_spec: unknown, command: string) => {
      await tick();
      // The second run's unconditional removal lands after the first run has retaken the lock.
      if (command.startsWith("rm -rf") && removals++ === 1) for (let i = 0; i < 4; i++) await tick();
      const runId = /printf 'runId=%s[^']*' '([^']+)'/.exec(command)?.[1] ?? "";
      let stdout = "";
      if (command.startsWith("rm -rf")) {
        owner = null;
      } else if (command.includes(".reap")) {
        const observed = /grep -qx 'runId=([^']+)'/.exec(command)?.[1] ?? null;
        if (reapHeld || owner !== observed) stdout = "BUSY\n";
        else { owner = runId; stdout = "ACQUIRED\n"; }
      } else if (command.includes("mkdir")) {
        if (owner === null) { owner = runId; stdout = "ACQUIRED\n"; }
        else stdout = `BUSY\nrunId=${owner}\nstartedAt=${Date.now()}\n`;
      }
      return { stdout, stderr: "" };
    }) as never);
    const run = (runId: string) => prepareRemoteManagedRuntime({
      spec: { ...stable, isRunActive: async (id) => id !== "run-dead" }, runId, adapterKey: "x",
      workspaceLocalDir: localDir, executionWorkspaceId: WS_ID,
    });
    const [a, b] = await Promise.all([run("run-a"), run("run-b")]);
    const stableDir = `/app/.paperclip-runtime/workspaces/${WS_ID}/workspace`;
    expect([a.workspaceRemoteDir, b.workspaceRemoteDir].filter((dir) => dir === stableDir)).toHaveLength(1);
    expect(owner === "run-a" ? a.workspaceRemoteDir : b.workspaceRemoteDir).toBe(stableDir);
  });
});

// Runs the generated remote commands in a real local shell, so a read-only tree behaves as on the host.
describe.skipIf(process.getuid?.() === 0)("read-only trees on the SSH host", () => {
  const WS_ID = "11111111-2222-4333-8444-555555555555";
  const OLD_ID = "99999999-2222-4333-8444-555555555555";
  let base = "";
  const bases: string[] = [];
  const spec = (key?: "execution_workspace") => ({
    host: "192.0.2.10", port: 22, username: "fixture", remoteWorkspacePath: base, remoteCwd: base,
    privateKey: null, knownHosts: null, strictHostKeyChecking: true, remoteWorkspaceKey: key,
  });

  // The shape a materialised skill leaves behind: read-only directories holding a read-only file.
  async function readOnlySkillTree(root: string) {
    const skill = path.join(root, ".paperclip-runtime", "claude", "skills", ".claude", "skills", "demo");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "x");
    for (const dir of [skill, path.dirname(skill), path.join(root, ".paperclip-runtime", "claude", "skills", ".claude"), path.join(root, ".paperclip-runtime", "claude", "skills")]) {
      await chmod(dir, 0o555);
    }
    await chmod(path.join(skill, "SKILL.md"), 0o444);
  }
  const exists = (p: string) => lstat(p).then(() => true, () => false);

  async function setup() {
    base = await mkdtemp(path.join(os.tmpdir(), "paperclip-ro-"));
    bases.push(base);
    runSshCommand.mockImplementation((async (_spec: unknown, command: string) => ({
      stdout: await new Promise<string>((resolve) => execFile("sh", ["-c", command], (_e, out) => resolve(out))),
      stderr: "",
    })) as never);
  }

  afterEach(async () => {
    runSshCommand.mockImplementation((async () => ({ stdout: "", stderr: "" })) as never);
    vi.clearAllMocks();
    for (const dir of bases.splice(0)) {
      await execFileP("chmod", ["-R", "u+w", dir]);
      await rm(dir, { recursive: true, force: true });
    }
  });
  const execFileP = (cmd: string, args: string[]) => new Promise<void>((resolve) => execFile(cmd, args, () => resolve()));

  it("removes a per-run folder holding read-only skill folders after a good restore", async () => {
    await setup();
    const prepared = await prepareRemoteManagedRuntime({
      spec: spec(), runId: "run-a", adapterKey: "claude", workspaceLocalDir: base, executionWorkspaceId: WS_ID,
    });
    const runDir = path.join(base, ".paperclip-runtime", "runs", "run-a");
    await readOnlySkillTree(path.join(runDir, "workspace"));
    await prepared.restoreWorkspace();
    expect(await exists(runDir)).toBe(false);
  });

  it("removes the runtime assets of a kept per-run workspace and of a stable workspace run", async () => {
    await setup();
    const runDir = path.join(base, ".paperclip-runtime", "runs", "run-a");
    const stableRoot = path.join(base, ".paperclip-runtime", "workspaces", WS_ID, "workspace");
    const prepared = await prepareRemoteManagedRuntime({
      spec: spec("execution_workspace"), runId: "run-a", adapterKey: "claude", workspaceLocalDir: base, executionWorkspaceId: WS_ID,
    });
    await readOnlySkillTree(path.join(runDir, "runtime"));
    await prepared.restoreWorkspace();
    expect(await exists(runDir)).toBe(false);
    expect(await exists(stableRoot)).toBe(false);
    // Failed restore keeps the per-run workspace but still drops its runtime assets.
    await setup();
    const kept = path.join(base, ".paperclip-runtime", "runs", "run-b", "workspace");
    const failing = await prepareRemoteManagedRuntime({
      spec: spec(), runId: "run-b", adapterKey: "claude", workspaceLocalDir: base,
    });
    await readOnlySkillTree(kept);
    restoreWorkspaceFromSshExecution.mockRejectedValueOnce(new Error("restore failed"));
    await expect(failing.restoreWorkspace()).rejects.toThrow("restore failed");
    expect(await exists(path.join(kept, ".paperclip-runtime"))).toBe(false);
  });

  it("never makes a symlink target writable when the kept workspace's runtime folder is a link", async () => {
    await setup();
    const kept = path.join(base, ".paperclip-runtime", "runs", "run-b", "workspace");
    const failing = await prepareRemoteManagedRuntime({
      spec: spec(), runId: "run-b", adapterKey: "claude", workspaceLocalDir: base,
    });
    const outside = path.join(base, "outside");
    await readOnlySkillTree(outside);
    await mkdir(kept, { recursive: true });
    await symlink(path.join(outside, ".paperclip-runtime"), path.join(kept, ".paperclip-runtime"));
    restoreWorkspaceFromSshExecution.mockRejectedValueOnce(new Error("restore failed"));
    await expect(failing.restoreWorkspace()).rejects.toThrow("restore failed");
    expect(await exists(path.join(kept, ".paperclip-runtime"))).toBe(false);
    const skills = await lstat(path.join(outside, ".paperclip-runtime", "claude", "skills"));
    expect(skills.mode & 0o222).toBe(0);
  });

  it("removes a closed stable workspace folder holding read-only skill folders", async () => {
    await setup();
    const dir = path.join(base, ".paperclip-runtime", "workspaces", WS_ID);
    await mkdir(path.join(dir, "workspace"), { recursive: true });
    await readOnlySkillTree(path.join(dir, "workspace"));
    await expect(removeStableSshWorkspaceFolder(spec(), base, WS_ID)).resolves.toBe("removed");
    expect(await exists(dir)).toBe(false);
  });

  it("sweeps a stale stable workspace folder holding read-only skill folders", async () => {
    await setup();
    const old = path.join(base, ".paperclip-runtime", "workspaces", OLD_ID);
    await mkdir(path.join(old, "workspace"), { recursive: true });
    await readOnlySkillTree(path.join(old, "workspace"));
    const marker = path.join(old, ".paperclip-last-restore");
    await writeFile(marker, "ok 1\n");
    const longAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    await utimes(marker, longAgo, longAgo);
    await prepareRemoteManagedRuntime({
      spec: spec("execution_workspace"), runId: "run-a", adapterKey: "claude", workspaceLocalDir: base, executionWorkspaceId: WS_ID,
    });
    expect(await exists(old)).toBe(false);
  });

  it("never follows a symlink planted in the folder when making it writable", async () => {
    await setup();
    const outside = path.join(base, "outside");
    await readOnlySkillTree(outside);
    const dir = path.join(base, ".paperclip-runtime", "workspaces", WS_ID);
    await mkdir(path.join(dir, "workspace"), { recursive: true });
    await symlink(outside, path.join(dir, "workspace", "link"));
    await symlink(path.join(outside, ".paperclip-runtime"), path.join(dir, "link2"));
    await removeStableSshWorkspaceFolder(spec(), base, WS_ID);
    const target = path.join(outside, ".paperclip-runtime", "claude", "skills");
    expect(await exists(dir)).toBe(false);
    expect((await lstat(target)).mode & 0o222).toBe(0);
    expect((await lstat(path.join(target, ".claude", "skills", "demo", "SKILL.md"))).mode & 0o222).toBe(0);
  });

  it("leaves a symlinked runs folder and its target untouched", async () => {
    await setup();
    const outside = path.join(base, "outside");
    await readOnlySkillTree(outside);
    await mkdir(path.join(base, ".paperclip-runtime"), { recursive: true });
    await symlink(outside, path.join(base, ".paperclip-runtime", "runs"));
    await prepareRemoteManagedRuntime({
      spec: spec(), runId: "run-a", adapterKey: "claude", workspaceLocalDir: base,
    }).then((p) => p.restoreWorkspace());
    expect((await lstat(path.join(outside, ".paperclip-runtime", "claude", "skills"))).mode & 0o222).toBe(0);
    expect(await exists(path.join(outside, ".paperclip-runtime", "claude", "skills", ".claude", "skills", "demo", "SKILL.md"))).toBe(true);
  });
});

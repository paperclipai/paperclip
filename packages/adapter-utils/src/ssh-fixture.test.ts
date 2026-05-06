import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSshSpawnTarget,
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  prepareWorkspaceForSshExecution,
  readSshEnvLabFixtureStatus,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  WorkspaceImportConflictError,
} from "./ssh.js";

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

describe("ssh env-lab fixture", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("starts an isolated sshd fixture and executes commands through it", async () => {
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      console.warn(
        `Skipping SSH env-lab fixture test: ${support.reason ?? "unsupported environment"}`,
      );
      return;
    }

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixture({ statePath });
    const config = await buildSshEnvLabFixtureConfig(started);
    const quotedWorkspace = JSON.stringify(started.workspaceDir);
    const result = await runSshCommand(
      config,
      `sh -lc 'cd ${quotedWorkspace} && pwd'`,
    );

    expect(result.stdout.trim()).toBe(started.workspaceDir);
    const status = await readSshEnvLabFixtureStatus(statePath);
    expect(status.running).toBe(true);

    await stopSshEnvLabFixture(statePath);

    const stopped = await readSshEnvLabFixtureStatus(statePath);
    expect(stopped.running).toBe(false);
  });

  it("forwards stdin to remote SSH commands", async () => {
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      console.warn(
        `Skipping SSH stdin forwarding test: ${support.reason ?? "unsupported environment"}`,
      );
      return;
    }

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixture({ statePath });
    const config = await buildSshEnvLabFixtureConfig(started);
    const remotePath = path.posix.join(started.workspaceDir, "stdin-forwarded.txt");

    await runSshCommand(
      config,
      `sh -lc 'cat > ${JSON.stringify(remotePath)}'`,
      {
        stdin: "hello over ssh stdin\n",
        timeoutMs: 30_000,
        maxBuffer: 256 * 1024,
      },
    );

    const result = await runSshCommand(
      config,
      `sh -lc 'cat ${JSON.stringify(remotePath)}'`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    expect(result.stdout).toBe("hello over ssh stdin\n");
  });

  it("does not treat an unrelated reused pid as the running fixture", async () => {
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      console.warn(
        `Skipping SSH env-lab fixture test: ${support.reason ?? "unsupported environment"}`,
      );
      return;
    }

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixture({ statePath });
    await stopSshEnvLabFixture(statePath);
    await mkdir(path.dirname(statePath), { recursive: true });

    await writeFile(
      statePath,
      JSON.stringify({ ...started, pid: process.pid }, null, 2),
      { mode: 0o600 },
    );

    const staleStatus = await readSshEnvLabFixtureStatus(statePath);
    expect(staleStatus.running).toBe(false);

    const restarted = await startSshEnvLabFixture({ statePath });
    expect(restarted.pid).not.toBe(process.pid);

    await stopSshEnvLabFixture(statePath);
  });

  it("rejects invalid environment variable keys when constructing SSH spawn targets", async () => {
    await expect(
      buildSshSpawnTarget({
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
        command: "env",
        args: [],
        env: {
          "BAD KEY": "value",
        },
      }),
    ).rejects.toThrow("Invalid SSH environment variable key: BAD KEY");
  });

  it("syncs a local directory into the remote fixture workspace", async () => {
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      console.warn(
        `Skipping SSH env-lab fixture test: ${support.reason ?? "unsupported environment"}`,
      );
      return;
    }

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, "message.txt"), "hello from paperclip\n", "utf8");
    await writeFile(path.join(localDir, "._message.txt"), "should never sync\n", "utf8");

    const started = await startSshEnvLabFixture({ statePath });
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay");

    await syncDirectoryToSsh({
      spec: {
        ...config,
        remoteCwd: started.workspaceDir,
      },
      localDir,
      remoteDir,
    });

    const result = await runSshCommand(
      config,
      `sh -lc 'cat ${JSON.stringify(path.posix.join(remoteDir, "message.txt"))} && if [ -e ${JSON.stringify(path.posix.join(remoteDir, "._message.txt"))} ]; then echo appledouble-present; fi'`,
    );

    expect(result.stdout).toContain("hello from paperclip");
    expect(result.stdout).not.toContain("appledouble-present");
  });

  it("can dereference local symlinks while syncing to the remote fixture", async () => {
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      console.warn(
        `Skipping SSH symlink sync test: ${support.reason ?? "unsupported environment"}`,
      );
      return;
    }

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const sourceDir = path.join(rootDir, "source");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(sourceDir, { recursive: true });
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(sourceDir, "auth.json"), "{\"token\":\"secret\"}\n", "utf8");
    await symlink(path.join(sourceDir, "auth.json"), path.join(localDir, "auth.json"));

    const started = await startSshEnvLabFixture({ statePath });
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay-follow-links");

    await syncDirectoryToSsh({
      spec: {
        ...config,
        remoteCwd: started.workspaceDir,
      },
      localDir,
      remoteDir,
      followSymlinks: true,
    });

    const result = await runSshCommand(
      config,
      `sh -lc 'if [ -L ${JSON.stringify(path.posix.join(remoteDir, "auth.json"))} ]; then echo symlink; else echo regular; fi && cat ${JSON.stringify(path.posix.join(remoteDir, "auth.json"))}'`,
    );

    expect(result.stdout).toContain("regular");
    expect(result.stdout).toContain("{\"token\":\"secret\"}");
  });

  it("round-trips a git workspace through the SSH fixture", async () => {
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      console.warn(
        `Skipping SSH workspace round-trip test: ${support.reason ?? "unsupported environment"}`,
      );
      return;
    }

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await writeFile(path.join(localRepo, "._tracked.txt"), "should stay local only\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);
    const originalHead = await git(localRepo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "dirty local\n", "utf8");
    await writeFile(path.join(localRepo, "untracked.txt"), "from local\n", "utf8");

    const started = await startSshEnvLabFixture({ statePath });
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    await prepareWorkspaceForSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
    });

    const remoteStatus = await runSshCommand(
      config,
      `sh -lc 'cd ${JSON.stringify(started.workspaceDir)} && git status --short'`,
    );
    expect(remoteStatus.stdout).toContain("M tracked.txt");
    expect(remoteStatus.stdout).toContain("?? untracked.txt");
    expect(remoteStatus.stdout).not.toContain("._tracked.txt");

    await runSshCommand(
      config,
      `sh -lc 'cd ${JSON.stringify(started.workspaceDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && git add tracked.txt untracked.txt && git commit -m "remote update" >/dev/null && printf "remote dirty\\n" > tracked.txt && printf "remote extra\\n" > remote-only.txt'`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
    });

    const restoredHead = await git(localRepo, ["rev-parse", "HEAD"]);
    expect(restoredHead).not.toBe(originalHead);
    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe("remote update");
    expect(await git(localRepo, ["status", "--short"])).toContain("M tracked.txt");
    expect(await git(localRepo, ["status", "--short"])).not.toContain("._tracked.txt");
  });

  // BLO-1497: stale files at incoming paths used to crash the import with
  // "Cannot open: File exists" and strand the next adapter run. The remote
  // tar extract now passes --overwrite, so two consecutive syncs over the
  // same destination must succeed.
  it("overwrites pre-existing files when re-syncing into the same remote workspace", async () => {
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      console.warn(
        `Skipping SSH overwrite-on-import test: ${support.reason ?? "unsupported environment"}`,
      );
      return;
    }

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(path.join(localDir, "release-eng-tmp", "magma-blo-1475", "orc8r", "cloud", "go", "serde"), {
      recursive: true,
    });
    await writeFile(path.join(localDir, "tracked.txt"), "first run\n", "utf8");
    await writeFile(
      path.join(localDir, "release-eng-tmp", "magma-blo-1475", "orc8r", "cloud", "go", "serde", "doc.go"),
      "// first run\n",
      "utf8",
    );

    const started = await startSshEnvLabFixture({ statePath });
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay-overwrite");

    await syncDirectoryToSsh({
      spec: { ...config, remoteCwd: started.workspaceDir },
      localDir,
      remoteDir,
    });

    await writeFile(path.join(localDir, "tracked.txt"), "second run\n", "utf8");
    await writeFile(
      path.join(localDir, "release-eng-tmp", "magma-blo-1475", "orc8r", "cloud", "go", "serde", "doc.go"),
      "// second run\n",
      "utf8",
    );

    await syncDirectoryToSsh({
      spec: { ...config, remoteCwd: started.workspaceDir },
      localDir,
      remoteDir,
    });

    const result = await runSshCommand(
      config,
      `sh -lc 'cat ${JSON.stringify(path.posix.join(remoteDir, "tracked.txt"))} && cat ${JSON.stringify(path.posix.join(remoteDir, "release-eng-tmp/magma-blo-1475/orc8r/cloud/go/serde/doc.go"))}'`,
    );
    expect(result.stdout).toContain("second run");
    expect(result.stdout).toContain("// second run");
    expect(result.stdout).not.toContain("first run");
  });

  // BLO-1497: when the remote already has a non-empty directory at the path
  // the incoming archive wants to occupy with a regular file, --overwrite
  // cannot unlink the directory. The import must surface a structured
  // WorkspaceImportConflictError carrying the offending path(s) so the
  // recovery owner can act in one heartbeat instead of inspecting the run
  // log.
  it("raises WorkspaceImportConflictError on a file-vs-dir path conflict", async () => {
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      console.warn(
        `Skipping SSH import-conflict test: ${support.reason ?? "unsupported environment"}`,
      );
      return;
    }

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");

    // Local has a *file* at "conflict"; we will pre-seed the remote with a
    // non-empty *directory* at the same path so the regular-file extract
    // cannot reconcile the type mismatch.
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, "conflict"), "from local\n", "utf8");

    const started = await startSshEnvLabFixture({ statePath });
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay-conflict");

    const remoteConflictDir = path.posix.join(remoteDir, "conflict");
    await runSshCommand(
      config,
      `sh -lc 'mkdir -p ${JSON.stringify(path.posix.join(remoteConflictDir, "child"))} && printf "blocker\\n" > ${JSON.stringify(path.posix.join(remoteConflictDir, "child", "leftover.txt"))}'`,
    );

    let caught: unknown;
    try {
      await syncDirectoryToSsh({
        spec: { ...config, remoteCwd: started.workspaceDir },
        localDir,
        remoteDir,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(WorkspaceImportConflictError);
    const conflict = caught as WorkspaceImportConflictError;
    expect(conflict.code).toBe("workspace_import_conflict");
    expect(conflict.paths.length).toBeGreaterThan(0);
    expect(conflict.paths.some((entry) => entry.includes("conflict"))).toBe(true);
  });
});

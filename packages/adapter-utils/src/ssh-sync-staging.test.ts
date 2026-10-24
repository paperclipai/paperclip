import { execFile, spawnSync } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { prepareAdapterExecutionTargetRuntime } from "./execution-target.js";
import { resolveNestedWorktreeExcludes } from "./exclude-patterns.js";
import { GIT_ARCHIVE_EXCLUDES } from "./git-workspace-sync.js";
import { restoreWorkspaceFromSshExecution, syncDirectoryToSsh, type SshRemoteExecutionSpec } from "./ssh.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

// A stand-in `ssh` that runs the remote command on this machine, so the real
// tar/du pipelines of the SSH workspace sync run without an sshd. The remote
// "host" is a local directory tree; remote login profiles are exercised as-is.
const FAKE_SSH = `#!/bin/sh
for last; do :; done
printf '%s\\n---\\n' "$last" >> "$FAKE_SSH_LOG"
if [ -n "$FAKE_SSH_HOOK_MATCH" ] && printf '%s' "$last" | grep -q -F -- "$FAKE_SSH_HOOK_MATCH"; then
  sh -c "$FAKE_SSH_HOOK"
  echo "injected ssh failure" >&2
  exit 1
fi
exec sh -c "$last"
`;

// A BSD-style du: it has no --exclude, and -I masks only match entry names.
const FAKE_BSD_DU = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_BSD_DU_LOG"
for arg; do
  case "$arg" in --exclude=*) exit 64;; esac
done
printf '999999999\\t.\\n'
`;

const FAKE_GIT = `#!/bin/sh
if [ "$1" = "-C" ] && [ "$2" = "$FAKE_GIT_LOCAL_DIR" ]; then
  for arg; do
    if [ "$arg" = "reset" ]; then
      if find "$TMPDIR" -maxdepth 2 -name workspace.bundle -type f -print -quit | grep -q .; then
        printf 'bundle-present\\n' >> "$FAKE_GIT_RESET_BUNDLE_LOG"
      else
        printf 'bundle-absent\\n' >> "$FAKE_GIT_RESET_BUNDLE_LOG"
      fi
    fi
  done
fi
exec "$FAKE_GIT_REAL_PATH" "$@"
`;

const realGitPath = spawnSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
  env: { ...process.env, PATH: "/usr/bin:/bin:/usr/local/bin" },
}).stdout.trim();
const MB = 1024 * 1024;
// The size probe needs GNU du (--exclude, --apparent-size) on the "remote".
const hasGnuDu = spawnSync("du", ["--version"], { stdio: "ignore" }).status === 0;
const itWithGnuDu = it.skipIf(!hasGnuDu);
const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]);
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

async function exists(target: string): Promise<boolean> {
  return await stat(target).then(() => true, () => false);
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else total += await stat(full).then((stats) => stats.size, () => 0);
  }
  return total;
}

describe("ssh workspace sync staging", { timeout: 90_000 }, () => {
  let root: string;
  let localDir: string;
  let remoteCwd: string;
  let stagingRoot: string;
  let bin: string;
  let sshLog: string;
  let bsdDuLog: string;
  let spec: SshRemoteExecutionSpec;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-staging-test-"));
    localDir = path.join(root, "local");
    remoteCwd = path.join(root, "remote");
    stagingRoot = path.join(root, "tmp");
    bin = path.join(root, "bin");
    sshLog = path.join(root, "ssh.log");
    bsdDuLog = path.join(root, "bsd-du.log");
    await Promise.all([localDir, remoteCwd, stagingRoot, bin].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(path.join(bin, "ssh"), FAKE_SSH, { mode: 0o755 });
    await writeFile(sshLog, "");
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("FAKE_SSH_LOG", sshLog);
    vi.stubEnv("FAKE_BSD_DU_LOG", bsdDuLog);
    // Every staging directory the sync creates lands in stagingRoot.
    vi.stubEnv("TMPDIR", stagingRoot);
    spec = {
      host: "127.0.0.1",
      port: 22,
      username: "fixture",
      remoteWorkspacePath: remoteCwd,
      remoteCwd,
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: false,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function writeTree(base: string, files: Record<string, string | Buffer>): Promise<void> {
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(base, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
  }

  function prepare(extra: Partial<Parameters<typeof prepareRemoteManagedRuntime>[0]> = {}) {
    return prepareRemoteManagedRuntime({
      spec,
      runId: "run-1",
      adapterKey: "test",
      workspaceLocalDir: localDir,
      ...extra,
    });
  }

  it.each([
    { label: "plain directory", gitBacked: false },
    { label: "git workspace", gitBacked: true },
  ])("neither uploads nor restores nested worktrees ($label)", async ({ gitBacked }) => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    if (gitBacked) {
      await git(localDir, ["init", "-q", "-b", "main"]);
      await git(localDir, ["add", "-A"]);
      await git(localDir, ["commit", "-q", "-m", "init"]);
    }
    await writeTree(localDir, {
      ".paperclip/keep.txt": "synced\n",
      ".paperclip/worktrees/wt1/big.bin": "local worktree one\n",
      ".claude/worktrees/wt2/notes.md": "local worktree two\n",
      "packages/a/.claude/worktrees/wt3/deep.txt": "local nested worktree\n",
    });

    const prepared = await prepare();
    const remote = prepared.workspaceRemoteDir;

    // Not uploaded: the worktrees never reach the remote, their siblings do.
    expect(await readFile(path.join(remote, "src/app.ts"), "utf8")).toBe("export const app = 1;\n");
    expect(await readFile(path.join(remote, ".paperclip/keep.txt"), "utf8")).toBe("synced\n");
    expect(await exists(path.join(remote, ".paperclip/worktrees"))).toBe(false);
    expect(await exists(path.join(remote, ".claude/worktrees"))).toBe(false);
    expect(await exists(path.join(remote, "packages/a/.claude/worktrees"))).toBe(false);

    // The remote run edits a tracked file and creates worktrees of its own.
    await writeTree(remote, {
      "src/app.ts": "export const app = 2;\n",
      "created-remotely.txt": "new\n",
      ".paperclip/worktrees/remote-made/file.txt": "remote worktree\n",
      ".claude/worktrees/remote-made/file.txt": "remote worktree\n",
    });
    await prepared.restoreWorkspace();

    // Restored: ordinary remote changes come back.
    expect(await readFile(path.join(localDir, "src/app.ts"), "utf8")).toBe("export const app = 2;\n");
    expect(await readFile(path.join(localDir, "created-remotely.txt"), "utf8")).toBe("new\n");
    // Not restored: remote-created worktrees stay remote.
    expect(await exists(path.join(localDir, ".paperclip/worktrees/remote-made"))).toBe(false);
    expect(await exists(path.join(localDir, ".claude/worktrees/remote-made"))).toBe(false);
    // The local worktrees are not mistaken for remote deletions.
    expect(await readFile(path.join(localDir, ".paperclip/worktrees/wt1/big.bin"), "utf8")).toBe("local worktree one\n");
    expect(await readFile(path.join(localDir, ".claude/worktrees/wt2/notes.md"), "utf8")).toBe("local worktree two\n");
    expect(await readFile(path.join(localDir, "packages/a/.claude/worktrees/wt3/deep.txt"), "utf8")).toBe("local nested worktree\n");
  });

  it("syncs nested worktrees when the default directories are overridden", async () => {
    await writeTree(localDir, {
      "src/app.ts": "export const app = 1;\n",
      ".paperclip/worktrees/wt1/file.txt": "wt1\n",
      ".claude/worktrees/wt2/file.txt": "wt2\n",
    });

    const prepared = await prepare({ nestedWorktreeDirs: [".claude/worktrees"] });

    expect(await exists(path.join(prepared.workspaceRemoteDir, ".paperclip/worktrees/wt1/file.txt"))).toBe(true);
    expect(await exists(path.join(prepared.workspaceRemoteDir, ".claude/worktrees"))).toBe(false);
  });

  it("keeps local nested worktrees when restoring without a baseline", async () => {
    await writeTree(localDir, {
      "stale.txt": "local only\n",
      ".paperclip/worktrees/wt1/file.txt": "local worktree\n",
      ".paperclip/other.txt": "local sibling\n",
    });
    const remote = path.join(remoteCwd, "ws");
    await writeTree(remote, {
      "fresh.txt": "remote\n",
      ".paperclip/worktrees/remote-made/file.txt": "remote worktree\n",
    });

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: remote });

    expect(await readFile(path.join(localDir, "fresh.txt"), "utf8")).toBe("remote\n");
    expect(await exists(path.join(localDir, "stale.txt"))).toBe(false);
    expect(await exists(path.join(localDir, ".paperclip/other.txt"))).toBe(false);
    expect(await readFile(path.join(localDir, ".paperclip/worktrees/wt1/file.txt"), "utf8")).toBe("local worktree\n");
    expect(await exists(path.join(localDir, ".paperclip/worktrees/remote-made"))).toBe(false);
  });

  it("stages the restore once: peak temp usage stays within 1x the restored size", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    const prepared = await prepare();
    const restoredBytes = 6 * 4 * MB;
    const blobs: Record<string, Buffer> = {};
    for (let index = 0; index < 6; index += 1) blobs[`data/blob-${index}.bin`] = Buffer.alloc(4 * MB, index + 1);
    await writeTree(prepared.workspaceRemoteDir, blobs);

    let peakBytes = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        peakBytes = Math.max(peakBytes, await directoryBytes(stagingRoot));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    try {
      await prepared.restoreWorkspace();
    } finally {
      sampling = false;
      await sampler;
    }

    expect((await readFile(path.join(localDir, "data/blob-5.bin"))).equals(Buffer.alloc(4 * MB, 6))).toBe(true);
    expect(peakBytes).toBeGreaterThan(0);
    expect(peakBytes).toBeLessThanOrEqual(restoredBytes * 1.25);
    expect(await readdir(stagingRoot)).toEqual([]);
  });

  itWithGnuDu("fails before the first write when the temp volume is too small", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    const prepared = await prepare();
    await writeTree(prepared.workspaceRemoteDir, {
      "src/app.ts": "export const app = 2;\n",
      "data/blob.bin": Buffer.alloc(2 * MB, 7),
    });
    expect(await readdir(stagingRoot)).toEqual([]);
    const mkdtemp = vi.spyOn(fsPromises, "mkdtemp");
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 1024, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);
    await writeFile(sshLog, "");

    await expect(prepared.restoreWorkspace()).rejects.toMatchObject({
      code: "ssh_sync_insufficient_staging_space",
      message: expect.stringMatching(/Not enough free space in .*tmp to restore the workspace from SSH/),
    });

    // No staging directory was created and the remote tree was never read.
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(await readFile(sshLog, "utf8")).not.toContain("-cf");
    expect(await readFile(path.join(localDir, "src/app.ts"), "utf8")).toBe("export const app = 1;\n");
    expect(await exists(path.join(localDir, "data"))).toBe(false);
  });

  // A workspace root plus one project repository, restored through a baseline.
  async function restoreRootAndRepository(input: {
    freeKiB: number;
    rootBytes: number;
    repositoryBytes: number;
    remoteRepository?: boolean;
    restoreGitHistory?: boolean;
  }): Promise<void> {
    const repositoryDir = ".paperclip-repositories/app";
    await writeTree(localDir, {
      "src/app.ts": "export const app = 1;\n",
      [`${repositoryDir}/README.md`]: "repository\n",
    });
    const rootExclude = [".paperclip-repositories", ...resolveNestedWorktreeExcludes({}), ...GIT_ARCHIVE_EXCLUDES];
    const repositoryExclude = [...resolveNestedWorktreeExcludes({}), ...GIT_ARCHIVE_EXCLUDES];
    const remote = path.join(remoteCwd, "ws");
    await writeTree(remote, {
      "src/app.ts": "export const app = 2;\n",
      "data/blob.bin": Buffer.alloc(input.rootBytes, 7),
    });
    if (input.remoteRepository !== false) {
      await writeTree(remote, {
        [`${repositoryDir}/README.md`]: "repository, edited remotely\n",
        [`${repositoryDir}/blob.bin`]: Buffer.alloc(input.repositoryBytes, 5),
      });
    }
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: input.freeKiB, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir,
      remoteDir: remote,
      restoreGitHistory: input.restoreGitHistory,
      baselineSnapshot: await captureDirectorySnapshot(localDir, { exclude: rootExclude }),
      repositories: [{
        path: repositoryDir,
        baselineSnapshot: await captureDirectorySnapshot(path.join(localDir, repositoryDir), { exclude: repositoryExclude }),
      }],
    });
  }

  itWithGnuDu("refuses a restore with several trees before it restores any of them", async () => {
    // Only the repository tree fits in 64 KiB; the workspace root does not.
    await expect(restoreRootAndRepository({ freeKiB: 64, rootBytes: 2 * MB, repositoryBytes: 1024 }))
      .rejects.toMatchObject({ code: "ssh_sync_insufficient_staging_space" });

    expect(await readFile(path.join(localDir, ".paperclip-repositories/app/README.md"), "utf8")).toBe("repository\n");
    expect(await readFile(path.join(localDir, "src/app.ts"), "utf8")).toBe("export const app = 1;\n");
  });

  itWithGnuDu("counts every tree and the largest one, since each merge can fill a shared volume", async () => {
    // 4.5 MiB covers twice the largest tree (2 MiB) but not 3 MiB of trees plus the largest.
    await expect(restoreRootAndRepository({ freeKiB: 4608, rootBytes: 2 * MB, repositoryBytes: 1 * MB }))
      .rejects.toMatchObject({ code: "ssh_sync_insufficient_staging_space" });
    expect(await readFile(path.join(localDir, "src/app.ts"), "utf8")).toBe("export const app = 1;\n");
  });

  itWithGnuDu("warns about a tree whose size is unknown and still checks the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(restoreRootAndRepository({ freeKiB: 64, rootBytes: 2 * MB, repositoryBytes: 1024, remoteRepository: false }))
      .rejects.toMatchObject({ code: "ssh_sync_insufficient_staging_space" });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skips 1 of 2 sizes"));
  });

  itWithGnuDu("counts the git history that is downloaded to the temp directory", async () => {
    // The files are small; the remote history is 4 MiB, so the bundle may be too.
    await mkdir(path.join(remoteCwd, "ws/.git/objects/pack"), { recursive: true });
    await writeFile(path.join(remoteCwd, "ws/.git/objects/pack/pack-1.pack"), Buffer.alloc(4 * MB, 3));

    await expect(restoreRootAndRepository({ freeKiB: 6 * 1024, rootBytes: 1024, repositoryBytes: 1024, restoreGitHistory: true }))
      .rejects.toMatchObject({ code: "ssh_sync_insufficient_staging_space" });
  });

  itWithGnuDu("sizes sparse files by what the extract writes", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    const prepared = await prepare();
    await writeFile(path.join(prepared.workspaceRemoteDir, "disk.img"), "");
    await truncate(path.join(prepared.workspaceRemoteDir, "disk.img"), 64 * MB);
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 8 * 1024, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);

    await expect(prepared.restoreWorkspace()).rejects.toMatchObject({ code: "ssh_sync_insufficient_staging_space" });
  });

  itWithGnuDu("counts each hard link in the free-space check, since the merge writes one copy per name", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    const prepared = await prepare();
    const remote = prepared.workspaceRemoteDir;
    await writeFile(path.join(remote, "data.bin"), Buffer.alloc(1 * MB, 7));
    for (let index = 0; index < 9; index += 1) {
      await link(path.join(remote, "data.bin"), path.join(remote, `link-${index}.bin`));
    }
    // Ten names share 1 MiB on disk, but the merge writes ten copies: 10 MiB to
    // restore, 20 MiB required. 12 MiB free fits the single-counted 2 MiB.
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 12 * 1024, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);

    await expect(prepared.restoreWorkspace()).rejects.toMatchObject({ code: "ssh_sync_insufficient_staging_space" });
    expect(await readFile(path.join(localDir, "src/app.ts"), "utf8")).toBe("export const app = 1;\n");
  });

  it("does not delete a local nested worktree when the remote replaces its parent directory", async () => {
    await writeTree(localDir, {
      "packages/a/x.ts": "local\n",
      "packages/a/.claude/worktrees/wt/f.txt": "local worktree\n",
      "other.txt": "local\n",
    });
    const prepared = await prepare();
    await rm(path.join(prepared.workspaceRemoteDir, "packages/a"), { recursive: true });
    await writeFile(path.join(prepared.workspaceRemoteDir, "packages/a"), "now a file\n");
    await writeFile(path.join(prepared.workspaceRemoteDir, "other.txt"), "remote\n");

    await expect(prepared.restoreWorkspace()).rejects.toMatchObject({ code: "workspace_restore_protected_children" });

    // The merge refuses before it applies anything.
    expect(await readFile(path.join(localDir, "packages/a/.claude/worktrees/wt/f.txt"), "utf8")).toBe("local worktree\n");
    expect(await readFile(path.join(localDir, "packages/a/x.ts"), "utf8")).toBe("local\n");
    expect(await readFile(path.join(localDir, "other.txt"), "utf8")).toBe("local\n");
  });

  it("refuses a protected parent replacement before the local branch advances", async () => {
    await writeTree(localDir, { "packages/a/x.ts": "local\n", "other.txt": "local\n" });
    await git(localDir, ["init", "-q", "-b", "main"]);
    await git(localDir, ["add", "-A"]);
    await git(localDir, ["commit", "-q", "-m", "init"]);
    // Untracked, so only the protection check stands between it and the merge.
    await writeTree(localDir, { "packages/a/.claude/worktrees/wt/f.txt": "local worktree\n" });
    const initialHead = await gitOutput(localDir, ["rev-parse", "main"]);
    const prepared = await prepare();
    const remote = prepared.workspaceRemoteDir;

    // The remote run commits, and replaces the directory that holds the worktree.
    await rm(path.join(remote, "packages/a"), { recursive: true });
    await writeFile(path.join(remote, "packages/a"), "now a file\n");
    await writeFile(path.join(remote, "other.txt"), "remote\n");
    await git(remote, ["add", "-A"]);
    await git(remote, ["commit", "-q", "-m", "remote work"]);

    await expect(prepared.restoreWorkspace()).rejects.toMatchObject({ code: "workspace_restore_protected_children" });

    // A refused restore leaves the checkout exactly as it was: same branch tip, same files.
    expect(await gitOutput(localDir, ["rev-parse", "main"])).toBe(initialHead);
    expect(await readFile(path.join(localDir, "packages/a/.claude/worktrees/wt/f.txt"), "utf8")).toBe("local worktree\n");
    expect(await readFile(path.join(localDir, "packages/a/x.ts"), "utf8")).toBe("local\n");
    expect(await readFile(path.join(localDir, "other.txt"), "utf8")).toBe("local\n");
  });

  it("keeps a local nested worktree inside a project repository", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    await git(localDir, ["init", "-q", "-b", "main"]);
    await git(localDir, ["add", "src"]);
    await git(localDir, ["commit", "-q", "-m", "init"]);
    const repository = path.join(localDir, ".paperclip-repositories/app");
    await writeTree(repository, { "README.md": "repository\n" });
    await git(repository, ["init", "-q", "-b", "main"]);
    await git(repository, ["add", "-A"]);
    await git(repository, ["commit", "-q", "-m", "init"]);
    // Untracked and never uploaded, so only the repository baseline exclude keeps
    // the restore from reading it as a deletion on the remote.
    await writeTree(repository, { ".claude/worktrees/wt/f.txt": "local worktree\n" });

    const prepared = await prepare();
    await writeFile(path.join(prepared.workspaceRemoteDir, ".paperclip-repositories/app/README.md"), "edited remotely\n");
    await prepared.restoreWorkspace();

    expect(await readFile(path.join(repository, "README.md"), "utf8")).toBe("edited remotely\n");
    expect(await readFile(path.join(repository, ".claude/worktrees/wt/f.txt"), "utf8")).toBe("local worktree\n");
  });

  async function localTreeWithCustomWorktree(): Promise<void> {
    await writeTree(localDir, {
      "custom/keep.txt": "local\n",
      "custom/wt/f.txt": "local worktree\n",
      "other.txt": "local\n",
    });
  }

  async function expectCustomWorktreeUntouched(): Promise<void> {
    expect(await readFile(path.join(localDir, "custom/wt/f.txt"), "utf8")).toBe("local worktree\n");
    expect(await readFile(path.join(localDir, "custom/keep.txt"), "utf8")).toBe("local\n");
    expect(await readFile(path.join(localDir, "other.txt"), "utf8")).toBe("local\n");
  }

  async function replaceCustomWithFile(remote: string): Promise<void> {
    await rm(path.join(remote, "custom"), { recursive: true });
    await writeFile(path.join(remote, "custom"), "now a file\n");
    await writeFile(path.join(remote, "other.txt"), "remote\n");
  }

  it("protects a custom nestedWorktreeDirs list when the remote replaces its parent directory", async () => {
    await localTreeWithCustomWorktree();
    const prepared = await prepare({ nestedWorktreeDirs: ["custom/wt"] });
    await replaceCustomWithFile(prepared.workspaceRemoteDir);

    await expect(prepared.restoreWorkspace()).rejects.toMatchObject({ code: "workspace_restore_protected_children" });

    await expectCustomWorktreeUntouched();
  });

  it("protects a custom nestedWorktreeDirs list in the restore that follows a failed asset upload", async () => {
    await localTreeWithCustomWorktree();
    const assetDir = path.join(root, "asset");
    await writeTree(assetDir, { "a.txt": "asset\n" });
    // The remote changes after the workspace upload, then the asset upload fails.
    const hook = `rm -rf '${remoteCwd}/.paperclip-runtime/runs/run-1/workspace/custom' && printf 'now a file\\n' > '${remoteCwd}/.paperclip-runtime/runs/run-1/workspace/custom'`;
    vi.stubEnv("FAKE_SSH_HOOK_MATCH", "failing-asset-marker");
    vi.stubEnv("FAKE_SSH_HOOK", hook);

    await expect(prepare({
      nestedWorktreeDirs: ["custom/wt"],
      assets: [{ key: "failing-asset-marker", localDir: assetDir }],
    })).rejects.toMatchObject({ code: "workspace_restore_protected_children" });

    await expectCustomWorktreeUntouched();
  });

  itWithGnuDu("sizes the free-space check by what will be restored, not by excluded paths", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    const prepared = await prepare();
    await writeTree(prepared.workspaceRemoteDir, {
      "data/blob.bin": Buffer.alloc(1 * MB, 3),
      // Excluded from the restore, so it must not count towards the estimate.
      ".paperclip/worktrees/remote-made/huge.bin": Buffer.alloc(24 * MB, 9),
    });
    // 4 MiB free covers 2x the 1 MiB restore but not 2x the 25 MiB on disk.
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 4096, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);

    await prepared.restoreWorkspace();

    expect((await stat(path.join(localDir, "data/blob.bin"))).size).toBe(1 * MB);
    expect(await exists(path.join(localDir, ".paperclip/worktrees"))).toBe(false);
  });

  it("skips the free-space check when the remote size cannot honor the excludes", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    const prepared = await prepare();
    await writeTree(prepared.workspaceRemoteDir, { "src/app.ts": "export const app = 2;\n" });
    // The remote's du cannot skip the nested worktrees, so its figure is an
    // overcount and must not refuse a restore that would fit.
    await writeFile(path.join(bin, "du"), FAKE_BSD_DU, { mode: 0o755 });
    await writeFile(path.join(root, ".profile"), `export PATH="${bin}:$PATH"\n`);
    vi.stubEnv("HOME", root);
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 1024, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await prepared.restoreWorkspace();

    expect(await readFile(path.join(localDir, "src/app.ts"), "utf8")).toBe("export const app = 2;\n");
    expect(await readFile(bsdDuLog, "utf8")).toMatch(/-sk -I/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("free-space check skips 1 of 1 sizes"));
  });

  it("uses BSD du's supported masks when no nested worktree directories are excluded", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    const prepared = await prepare({ nestedWorktreeDirs: [] });
    await writeTree(prepared.workspaceRemoteDir, {
      "src/app.ts": "export const app = 2;\n",
      ".paperclip/worktrees/wt/large.bin": Buffer.alloc(24 * MB, 9),
    });
    await writeFile(path.join(bin, "du"), FAKE_BSD_DU, { mode: 0o755 });
    await writeFile(path.join(root, ".profile"), `export PATH="${bin}:$PATH"\n`);
    vi.stubEnv("HOME", root);
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 1024, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);

    await expect(prepared.restoreWorkspace()).rejects.toMatchObject({ code: "ssh_sync_insufficient_staging_space" });

    const calls = await readFile(bsdDuLog, "utf8");
    expect(calls).toContain("-sk -I ._* -I .paperclip-runtime .");
    expect(await exists(path.join(localDir, ".paperclip/worktrees/wt/large.bin"))).toBe(false);
  });

  it("keeps local nested worktrees at any depth when restoring without a baseline", async () => {
    await writeTree(localDir, {
      "packages/a/x.ts": "local\n",
      "packages/a/.claude/worktrees/wt3/deep.txt": "local nested worktree\n",
      "node_modules/pkg/index.js": "stale\n",
    });
    const remote = path.join(remoteCwd, "ws");
    await writeTree(remote, { "packages/a/x.ts": "remote\n" });

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: remote });

    expect(await readFile(path.join(localDir, "packages/a/x.ts"), "utf8")).toBe("remote\n");
    expect(await readFile(path.join(localDir, "packages/a/.claude/worktrees/wt3/deep.txt"), "utf8")).toBe("local nested worktree\n");
    expect(await exists(path.join(localDir, "node_modules"))).toBe(false);
  });

  it("preserves a no-baseline nested worktree symlink without following it", async () => {
    const target = path.join(root, "external-worktree");
    await writeTree(target, { "tracked.txt": "outside workspace\n" });
    await mkdir(path.join(localDir, "packages/a/.claude"), { recursive: true });
    await symlink(target, path.join(localDir, "packages/a/.claude/worktrees"), "dir");
    await writeFile(path.join(localDir, "stale.txt"), "remove me\\n");
    const remote = path.join(remoteCwd, "ws");
    await writeTree(remote, { "packages/a/app.ts": "remote\\n" });

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: remote });

    expect(await readFile(path.join(localDir, "packages/a/app.ts"), "utf8")).toBe("remote\\n");
    expect(await readFile(path.join(localDir, "packages/a/.claude/worktrees/tracked.txt"), "utf8")).toBe("outside workspace\n");
    expect(await readFile(path.join(localDir, "stale.txt")).catch(() => null)).toBeNull();
  });

  it("refuses a no-baseline restore that replaces a kept worktree's parent before clearing anything", async () => {
    await writeTree(localDir, {
      "packages/a/x.ts": "local\n",
      "packages/a/.claude/worktrees/wt/f.txt": "local worktree\n",
      "other.txt": "local\n",
    });
    const remote = path.join(remoteCwd, "ws");
    await writeTree(remote, {
      // The remote replaces the directory holding the local worktree with a file.
      "packages/a": "now a file\n",
      "other.txt": "remote\n",
    });

    await expect(restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: remote }))
      .rejects.toMatchObject({ code: "workspace_restore_protected_children" });

    // The refusal lands before the clear, so unrelated local files survive too.
    expect(await readFile(path.join(localDir, "packages/a/.claude/worktrees/wt/f.txt"), "utf8")).toBe("local worktree\n");
    expect(await readFile(path.join(localDir, "packages/a/x.ts"), "utf8")).toBe("local\n");
    expect(await readFile(path.join(localDir, "other.txt"), "utf8")).toBe("local\n");
  });

  itWithGnuDu("fails a no-baseline git restore before the branch advances when the temp volume is too small", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    await git(localDir, ["init", "-q", "-b", "main"]);
    await git(localDir, ["add", "-A"]);
    await git(localDir, ["commit", "-q", "-m", "init"]);
    const initialHead = await gitOutput(localDir, ["rev-parse", "main"]);
    const prepared = await prepare();
    const remote = prepared.workspaceRemoteDir;
    await writeFile(path.join(remote, "data.bin"), Buffer.alloc(2 * MB, 7));
    await git(remote, ["add", "-A"]);
    await git(remote, ["commit", "-q", "-m", "remote work"]);
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 1024, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);

    await expect(restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: remote }))
      .rejects.toMatchObject({ code: "ssh_sync_insufficient_staging_space" });

    // The refusal lands before the export, so the branch tip and files are untouched.
    expect(await gitOutput(localDir, ["rev-parse", "main"])).toBe(initialHead);
    expect(await readFile(path.join(localDir, "src/app.ts"), "utf8")).toBe("export const app = 1;\n");
    expect(await exists(path.join(localDir, "data.bin"))).toBe(false);
  });

  it("removes the downloaded history bundle before resetting the local checkout", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\\n" });
    await git(localDir, ["init", "-q", "-b", "main"]);
    await git(localDir, ["add", "-A"]);
    await git(localDir, ["commit", "-q", "-m", "init"]);
    const prepared = await prepare();
    const remote = prepared.workspaceRemoteDir;
    await writeFile(path.join(remote, "data.bin"), Buffer.alloc(2 * MB, 7));
    await git(remote, ["add", "-A"]);
    await git(remote, ["commit", "-q", "-m", "remote work"]);

    const resetBundleLog = path.join(root, "reset-bundle.log");
    await writeFile(path.join(bin, "git"), FAKE_GIT, { mode: 0o755 });
    await writeFile(resetBundleLog, "");
    vi.stubEnv("FAKE_GIT_REAL_PATH", realGitPath);
    vi.stubEnv("FAKE_GIT_LOCAL_DIR", localDir);
    vi.stubEnv("FAKE_GIT_RESET_BUNDLE_LOG", resetBundleLog);

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: remote });

    expect(await readFile(resetBundleLog, "utf8")).toContain("bundle-absent");
    expect(await readFile(path.join(localDir, "data.bin"))).toHaveLength(2 * MB);
  });

  it("refuses a no-baseline git restore that replaces a kept worktree's parent without moving the branch", async () => {
    await writeTree(localDir, { "packages/a/x.ts": "local\n", "other.txt": "local\n" });
    await git(localDir, ["init", "-q", "-b", "main"]);
    await git(localDir, ["add", "-A"]);
    await git(localDir, ["commit", "-q", "-m", "init"]);
    // Untracked, so only the protection check stands between it and the reset.
    await writeTree(localDir, { "packages/a/.claude/worktrees/wt/f.txt": "local worktree\n" });
    const initialHead = await gitOutput(localDir, ["rev-parse", "main"]);
    const prepared = await prepare();
    const remote = prepared.workspaceRemoteDir;

    // The remote run commits, and replaces the directory that holds the worktree.
    await rm(path.join(remote, "packages/a"), { recursive: true });
    await writeFile(path.join(remote, "packages/a"), "now a file\n");
    await writeFile(path.join(remote, "other.txt"), "remote\n");
    await git(remote, ["add", "-A"]);
    await git(remote, ["commit", "-q", "-m", "remote work"]);

    await expect(restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: remote }))
      .rejects.toMatchObject({ code: "workspace_restore_protected_children" });

    // A refused restore leaves the checkout exactly as it was: same branch tip, same files.
    expect(await gitOutput(localDir, ["rev-parse", "main"])).toBe(initialHead);
    expect(await readFile(path.join(localDir, "packages/a/.claude/worktrees/wt/f.txt"), "utf8")).toBe("local worktree\n");
    expect(await readFile(path.join(localDir, "packages/a/x.ts"), "utf8")).toBe("local\n");
    expect(await readFile(path.join(localDir, "other.txt"), "utf8")).toBe("local\n");
  });

  it("does not restore remote-made nested worktrees in a no-baseline git restore", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    await git(localDir, ["init", "-q", "-b", "main"]);
    await git(localDir, ["add", "-A"]);
    await git(localDir, ["commit", "-q", "-m", "init"]);
    // Untracked locally, so only the staged-tree exclude keeps the remote's
    // worktrees out of the kept local worktree.
    await writeTree(localDir, { ".claude/worktrees/wt/local.txt": "local worktree\n" });
    const prepared = await prepare();
    const remote = prepared.workspaceRemoteDir;

    // The remote run commits one tracked file and leaves worktrees of its own
    // untracked; only the tracked file may come back.
    await writeTree(remote, {
      "fresh.txt": "fresh\n",
      ".claude/worktrees/wt/remote-made.txt": "remote worktree\n",
      ".claude/worktrees/other/file.txt": "remote worktree\n",
    });
    await git(remote, ["add", "fresh.txt"]);
    await git(remote, ["commit", "-q", "-m", "remote work"]);

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: remote });

    expect(await readFile(path.join(localDir, "fresh.txt"), "utf8")).toBe("fresh\n");
    expect(await readFile(path.join(localDir, ".claude/worktrees/wt/local.txt"), "utf8")).toBe("local worktree\n");
    expect(await exists(path.join(localDir, ".claude/worktrees/wt/remote-made.txt"))).toBe(false);
    expect(await exists(path.join(localDir, ".claude/worktrees/other"))).toBe(false);
  });

  it("forwards nestedWorktreeDirs from the adapter entrypoint", async () => {
    await writeTree(localDir, {
      "src/app.ts": "export const app = 1;\n",
      ".claude/worktrees/wt/file.txt": "wt\n",
    });

    const prepared = await prepareAdapterExecutionTargetRuntime({
      runId: "run-1",
      target: { kind: "remote" as const, transport: "ssh" as const, remoteCwd, spec },
      adapterKey: "test",
      workspaceLocalDir: localDir,
      // Empty: nested worktrees sync like ordinary files.
      nestedWorktreeDirs: [],
    });

    expect(prepared.workspaceRemoteDir).not.toBeNull();
    expect(await readFile(path.join(prepared.workspaceRemoteDir!, ".claude/worktrees/wt/file.txt"), "utf8")).toBe("wt\n");
    await prepared.restoreWorkspace();
    expect(await readFile(path.join(localDir, ".claude/worktrees/wt/file.txt"), "utf8")).toBe("wt\n");
  });

  itWithGnuDu("does not count excluded nested worktrees when sizing repository trees", async () => {
    const repositoryDir = ".paperclip-repositories/app";
    await writeTree(localDir, {
      "src/app.ts": "export const app = 1;\n",
      [`${repositoryDir}/README.md`]: "repository\n",
    });
    const rootExclude = [".paperclip-repositories", ...resolveNestedWorktreeExcludes({}), ...GIT_ARCHIVE_EXCLUDES];
    const repositoryExclude = [...resolveNestedWorktreeExcludes({}), ...GIT_ARCHIVE_EXCLUDES];
    const remote = path.join(remoteCwd, "ws");
    await writeTree(remote, {
      "src/app.ts": "export const app = 2;\n",
      "data/blob.bin": Buffer.alloc(1024, 7),
      [`${repositoryDir}/README.md`]: "repository, edited remotely\n",
      [`${repositoryDir}/blob.bin`]: Buffer.alloc(1024, 5),
      // Excluded from the restore, so it must not count towards the estimate.
      [`${repositoryDir}/.claude/worktrees/x/big.bin`]: Buffer.alloc(10 * MB, 9),
    });
    // 64 KiB covers 2x the small trees but not 2x the 10 MiB worktree on disk.
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 64, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir,
      remoteDir: remote,
      baselineSnapshot: await captureDirectorySnapshot(localDir, { exclude: rootExclude }),
      repositories: [{
        path: repositoryDir,
        baselineSnapshot: await captureDirectorySnapshot(path.join(localDir, repositoryDir), { exclude: repositoryExclude }),
      }],
    });

    expect(await readFile(path.join(localDir, "src/app.ts"), "utf8")).toBe("export const app = 2;\n");
    expect(await readFile(path.join(localDir, `${repositoryDir}/README.md`), "utf8")).toBe("repository, edited remotely\n");
    expect(await exists(path.join(localDir, `${repositoryDir}/.claude/worktrees`))).toBe(false);
  });

  itWithGnuDu("does not count excluded nested worktrees in a plain no-baseline restore probe", async () => {
    await writeTree(localDir, { "src/app.ts": "local\n" });
    const remote = path.join(remoteCwd, "ws");
    await writeTree(remote, {
      "src/app.ts": "remote\n",
      ".claude/worktrees/x/big.bin": Buffer.alloc(10 * MB, 7),
    });
    // 64 KiB covers 2x the small restore but not 2x the 10 MiB on disk.
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 64, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: remote });

    expect(await readFile(path.join(localDir, "src/app.ts"), "utf8")).toBe("remote\n");
    expect(await exists(path.join(localDir, ".claude/worktrees"))).toBe(false);
  });

  itWithGnuDu("counts the remote git history in a no-baseline git restore", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    await git(localDir, ["init", "-q", "-b", "main"]);
    await git(localDir, ["add", "-A"]);
    await git(localDir, ["commit", "-q", "-m", "init"]);
    const initialHead = await gitOutput(localDir, ["rev-parse", "main"]);
    const prepared = await prepare();
    const remote = prepared.workspaceRemoteDir;
    await writeTree(remote, { "fresh.txt": "fresh\n" });
    await git(remote, ["add", "-A"]);
    await git(remote, ["commit", "-q", "-m", "remote work"]);
    // The working tree is tiny; the history bundle is not.
    await mkdir(path.join(remote, ".git/objects/pack"), { recursive: true });
    await writeFile(path.join(remote, ".git/objects/pack/pack-1.pack"), Buffer.alloc(4 * MB, 3));
    // 1 MiB covers 2x the tiny tree but not tree + 4 MiB history + largest.
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 1024, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);

    await expect(restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: remote }))
      .rejects.toMatchObject({ code: "ssh_sync_insufficient_staging_space" });

    // The refusal lands before the export, so the branch tip and files are untouched.
    expect(await gitOutput(localDir, ["rev-parse", "main"])).toBe(initialHead);
    expect(await exists(path.join(localDir, "fresh.txt"))).toBe(false);
  });

  it("excludes deep nested worktrees from the upload size estimate", async () => {
    await writeTree(localDir, {
      "src/app.ts": "export const app = 1;\n",
      "packages/a/.claude/worktrees/wt/big.bin": Buffer.alloc(5 * MB, 9),
    });
    const lines: string[] = [];
    const remote = path.join(remoteCwd, "ws");

    await syncDirectoryToSsh({
      spec,
      localDir,
      remoteDir: remote,
      exclude: [".paperclip-runtime", ...resolveNestedWorktreeExcludes({})],
      onProgress: (line) => { lines.push(line); },
      progressLabel: "workspace",
    });

    expect(await readFile(path.join(remote, "src/app.ts"), "utf8")).toBe("export const app = 1;\n");
    expect(await exists(path.join(remote, "packages/a/.claude/worktrees"))).toBe(false);
    // The terminal line reports the estimated total: bytes, not megabytes.
    const done = lines.filter((line) => line.includes("100%"));
    expect(done.length).toBeGreaterThan(0);
    expect(done[done.length - 1]).toContain("/0.0 MB");
  });

  itWithGnuDu("reports a percent total on a baseline restore when the remote size is known", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    const prepared = await prepare();
    await writeTree(prepared.workspaceRemoteDir, { "src/app.ts": "export const app = 2;\n" });
    const lines: string[] = [];

    await prepared.restoreWorkspace(async (line) => { lines.push(line); });

    expect(await readFile(path.join(localDir, "src/app.ts"), "utf8")).toBe("export const app = 2;\n");
    expect(lines.some((line) => line.includes("%"))).toBe(true);
  });

  it("normalizes the configured directories and rejects patterns tar and the baseline would read differently", () => {
    expect(resolveNestedWorktreeExcludes({ nestedWorktreeDirs: ["./wt/", "/other"] })).toEqual([
      "wt", "wt/*", "*/wt", "*/wt/*",
      "other", "other/*", "*/other", "*/other/*",
    ]);
    expect(resolveNestedWorktreeExcludes({ nestedWorktreeDirs: [] })).toEqual([]);
    for (const invalid of ["", ".", "worktrees-*", "a/../b", "a//b", "wt[1]"]) {
      expect(() => resolveNestedWorktreeExcludes({ nestedWorktreeDirs: [invalid] })).toThrow(/Invalid nested worktree directory/);
    }
  });
});

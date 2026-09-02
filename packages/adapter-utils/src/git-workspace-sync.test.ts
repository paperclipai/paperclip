import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRemoteGitDeltaBundleScript,
  createImportedGitRef,
  createRemoteGitExportRef,
  deleteLocalGitRef,
  fetchGitBundleIntoLocalRef,
  integrateImportedGitHead,
  isMissingGitPrerequisiteError,
  readGitWorkspaceSnapshot,
  ReferencedSourceIgnoreScanLimitExceededError,
  readReferencedSourceGitIgnoredPaths,
  REFERENCED_SOURCE_IGNORE_MAX_ENTRY_COUNT,
  REFERENCED_SOURCE_IGNORE_MAX_TOTAL_BYTES,
  runLocalGit,
  sanitizeGitRemoteUrl,
  setExpensiveWorkspaceGitExecutor,
  withShallowGitWorkspaceClone,
} from "./git-workspace-sync.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runLocalGit(cwd, args)).stdout.trim();
}

describe("git workspace sync", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    setExpensiveWorkspaceGitExecutor(null);
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("delegates every host-side full-tree enumeration to the registered scheduler", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-scheduler-hook-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    await writeFile(path.join(repo, "untracked.txt"), "untracked\n", "utf8");
    const operations: string[] = [];
    setExpensiveWorkspaceGitExecutor(async (input) => {
      operations.push(input.operation);
      return await runLocalGit(input.localDir, [...input.args], {
        timeout: input.timeout,
        maxBuffer: input.maxBuffer,
      });
    });

    const snapshot = await readGitWorkspaceSnapshot(repo);

    expect(snapshot?.overlayPaths).toContain("untracked.txt");
    expect(operations.sort()).toEqual([
      "adapter_sync.deleted_files",
      "adapter_sync.ignored_files",
      "adapter_sync.overlay_diff",
      "adapter_sync.untracked_files",
    ]);
  });

  it("keeps every filename byte for a padded name in each of the four anchor lanes", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-anchor-whitespace-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);

    // Deleted lane: commit the file first (in isolation, before anything else
    // is staged), then remove it from the work tree.
    const deletedName = " deleted padded ";
    await writeFile(path.join(repo, deletedName), "deleted\n", "utf8");
    await git(repo, ["add", deletedName]);
    await git(repo, ["commit", "-qm", "add deleted padded"]);
    await rm(path.join(repo, deletedName));

    // Overlay lane, staged-new half: `git diff --diff-filter=ACMRTUXB HEAD`
    // reports a staged-but-uncommitted file as added.
    const overlayName = " overlay padded ";
    await writeFile(path.join(repo, overlayName), "overlay\n", "utf8");
    await git(repo, ["add", overlayName]);

    // Overlay lane, untracked half: `ls-files --others --exclude-standard`.
    const untrackedName = " untracked padded ";
    await writeFile(path.join(repo, untrackedName), "untracked\n", "utf8");

    // Ignored lane: a double-wildcard pattern avoids the separate rule that
    // Git trims an unescaped trailing space in a .gitignore PATTERN itself;
    // the padding under test lives in the matched FILE name.
    const ignoredName = " ignored padded ";
    await writeFile(path.join(repo, ".gitignore"), "*ignored*padded*\n", "utf8");
    await writeFile(path.join(repo, ignoredName), "ignored\n", "utf8");

    const snapshot = await readGitWorkspaceSnapshot(repo);

    expect(snapshot?.overlayPaths).toContain(overlayName);
    expect(snapshot?.overlayPaths).toContain(untrackedName);
    expect(snapshot?.deletedPaths).toContain(deletedName);
    expect(snapshot?.ignoredPaths).toContain(ignoredName);
  });

  async function createRepo(rootDir: string): Promise<string> {
    const repo = path.join(rootDir, "repo");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init"]);
    await git(repo, ["checkout", "-b", "main"]);
    await git(repo, ["config", "user.name", "Paperclip Test"]);
    await git(repo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await git(repo, ["add", "tracked.txt"]);
    await git(repo, ["commit", "-m", "base"]);
    return repo;
  }

  it("creates a shallow standalone clone from the local HEAD snapshot", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-sync-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    const baseHead = await git(repo, ["rev-parse", "HEAD"]);
    await rm(path.join(repo, "tracked.txt"));

    const snapshot = await readGitWorkspaceSnapshot(repo);
    expect(snapshot).toMatchObject({
      headCommit: baseHead,
      branchName: "main",
      deletedPaths: ["tracked.txt"],
    });

    await withShallowGitWorkspaceClone({
      localDir: repo,
      snapshot: snapshot!,
    }, async (cloneDir) => {
      expect((await lstat(path.join(cloneDir, ".git"))).isDirectory()).toBe(true);
      await expect(readFile(path.join(cloneDir, ".git", "shallow"), "utf8")).resolves.toContain(baseHead);
      expect(await git(cloneDir, ["rev-list", "--count", "HEAD"])).toBe("1");
      expect(await git(cloneDir, ["branch", "--show-current"])).toBe("main");
      await expect(readFile(path.join(cloneDir, "tracked.txt"), "utf8")).resolves.toBe("base\n");
    });
  });

  it("copies the workspace origin remote into the shallow clone", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-origin-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    await git(repo, ["remote", "add", "origin", "https://github.com/example/repo.git"]);

    const snapshot = await readGitWorkspaceSnapshot(repo);
    await withShallowGitWorkspaceClone({
      localDir: repo,
      snapshot: snapshot!,
    }, async (cloneDir) => {
      expect(await git(cloneDir, ["remote", "get-url", "origin"])).toBe("https://github.com/example/repo.git");
    });
  });

  it("scrubs credentials from the origin remote before copying it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-origin-scrub-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    await git(repo, ["remote", "add", "origin", "https://x-access-token:sekret@github.com/example/repo.git"]);

    const snapshot = await readGitWorkspaceSnapshot(repo);
    await withShallowGitWorkspaceClone({
      localDir: repo,
      snapshot: snapshot!,
    }, async (cloneDir) => {
      expect(await git(cloneDir, ["remote", "get-url", "origin"])).toBe("https://github.com/example/repo.git");
    });
  });

  it("leaves the shallow clone remote-less when the workspace has no origin", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-no-origin-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);

    const snapshot = await readGitWorkspaceSnapshot(repo);
    await withShallowGitWorkspaceClone({
      localDir: repo,
      snapshot: snapshot!,
    }, async (cloneDir) => {
      await expect(git(cloneDir, ["remote", "get-url", "origin"])).rejects.toThrow();
    });
  });

  it("drops a filesystem-path origin instead of copying it into the shallow clone", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-path-origin-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    await git(repo, ["remote", "add", "origin", path.join(rootDir, "elsewhere.git")]);

    const snapshot = await readGitWorkspaceSnapshot(repo);
    await withShallowGitWorkspaceClone({
      localDir: repo,
      snapshot: snapshot!,
    }, async (cloneDir) => {
      await expect(git(cloneDir, ["remote", "get-url", "origin"])).rejects.toThrow();
    });
  });

  it("pushes new commits from the shallow clone to an origin that holds the base commit", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-shallow-push-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    const upstream = path.join(rootDir, "upstream.git");
    await mkdir(upstream, { recursive: true });
    await git(upstream, ["init", "--bare"]);
    await git(repo, ["remote", "add", "origin", upstream]);
    await git(repo, ["push", "origin", "main"]);
    const baseHead = await git(repo, ["rev-parse", "HEAD"]);

    const snapshot = await readGitWorkspaceSnapshot(repo);
    await withShallowGitWorkspaceClone({
      localDir: repo,
      snapshot: snapshot!,
    }, async (cloneDir) => {
      await git(cloneDir, ["config", "user.name", "Paperclip Sandbox"]);
      await git(cloneDir, ["config", "user.email", "sandbox@paperclip.dev"]);
      await writeFile(path.join(cloneDir, "change.txt"), "sandbox change\n", "utf8");
      await git(cloneDir, ["add", "change.txt"]);
      await git(cloneDir, ["commit", "-m", "sandbox change"]);
      const cloneHead = await git(cloneDir, ["rev-parse", "HEAD"]);

      // A filesystem-path origin is dropped by the allowlist, so configure the
      // remote explicitly — the property under test is the push itself: the
      // clone is shallow (single grafted commit), but the boundary commit
      // already exists on the origin, so the push pack closes without full
      // ancestry. That is what makes transported branches publishable.
      await git(cloneDir, ["remote", "add", "origin", upstream]);
      await git(cloneDir, ["push", "origin", "HEAD:refs/heads/sandbox-change"]);

      expect(await git(upstream, ["rev-parse", "refs/heads/sandbox-change"])).toBe(cloneHead);
      expect(await git(upstream, ["merge-base", "refs/heads/main", "refs/heads/sandbox-change"])).toBe(baseHead);
    });
  });

  it("builds thin git delta bundles relative to the imported base", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-delta-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    const baseHead = await git(repo, ["rev-parse", "HEAD"]);
    const snapshot = await readGitWorkspaceSnapshot(repo);
    expect(snapshot).not.toBeNull();

    await withShallowGitWorkspaceClone({
      localDir: repo,
      snapshot: snapshot!,
    }, async (remoteDir) => {
      const emptyBundle = path.join(rootDir, "empty.bundle");
      await execFile("sh", ["-c", buildRemoteGitDeltaBundleScript({
        remoteDir,
        baseSha: baseHead,
        exportRef: createRemoteGitExportRef("test"),
        bundlePath: emptyBundle,
      })]);
      expect((await stat(emptyBundle)).size).toBe(0);

      await git(remoteDir, ["config", "user.name", "Paperclip Remote"]);
      await git(remoteDir, ["config", "user.email", "remote@paperclip.dev"]);
      await writeFile(path.join(remoteDir, "tracked.txt"), "remote\n", "utf8");
      await git(remoteDir, ["commit", "-am", "remote update"]);
      const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);

      const deltaBundle = path.join(rootDir, "delta.bundle");
      const importedRef = createImportedGitRef("test");
      const exportRef = createRemoteGitExportRef("test");
      try {
        await execFile("sh", ["-c", buildRemoteGitDeltaBundleScript({
          remoteDir,
          baseSha: baseHead,
          exportRef,
          bundlePath: deltaBundle,
        })]);
        expect((await stat(deltaBundle)).size).toBeGreaterThan(0);

        const importedHead = await fetchGitBundleIntoLocalRef({
          localDir: repo,
          bundlePath: deltaBundle,
          exportRef,
          importedRef,
          baseSha: baseHead,
        });
        expect(importedHead).toBe(remoteHead);
        expect(await git(repo, ["rev-list", "--count", importedRef, "--not", baseHead])).toBe("1");
      } finally {
        await deleteLocalGitRef({ localDir: repo, ref: importedRef });
      }
    });
  });

  it("imports a diverged sandbox HEAD even when the host no longer holds baseSha", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-diverge-"));
    cleanupDirs.push(rootDir);
    // Host holds only the shared ancestor B (the eventual merge-base), not the
    // recorded base H — the state a shared workspace lands in when it is reset
    // between export and import.
    const host = await createRepo(rootDir);
    const mergeBase = await git(host, ["rev-parse", "HEAD"]);

    // Sandbox holds B, an advanced commit H (the recorded baseSha), and a
    // local-only commit S that forked from B and diverges from H.
    const sandbox = path.join(rootDir, "sandbox");
    await git(rootDir, ["clone", host, sandbox]);
    await git(sandbox, ["config", "user.name", "Paperclip Remote"]);
    await git(sandbox, ["config", "user.email", "remote@paperclip.dev"]);
    await writeFile(path.join(sandbox, "advance.txt"), "advance\n", "utf8");
    await git(sandbox, ["add", "-A"]);
    await git(sandbox, ["commit", "-m", "advance"]);
    const baseSha = await git(sandbox, ["rev-parse", "HEAD"]);
    await git(sandbox, ["reset", "--hard", mergeBase]);
    await writeFile(path.join(sandbox, "local.txt"), "local\n", "utf8");
    await git(sandbox, ["add", "-A"]);
    await git(sandbox, ["commit", "-m", "local-only"]);
    const sandboxHead = await git(sandbox, ["rev-parse", "HEAD"]);

    // The host genuinely lacks baseSha; the old thin bundle would name it as an
    // unsatisfiable prerequisite.
    await expect(git(host, ["cat-file", "-e", `${baseSha}^{commit}`])).rejects.toThrow();

    const bundle = path.join(rootDir, "diverge.bundle");
    const exportRef = createRemoteGitExportRef("test");
    const importedRef = createImportedGitRef("test");
    try {
      await execFile("sh", ["-c", buildRemoteGitDeltaBundleScript({
        remoteDir: sandbox,
        baseSha,
        exportRef,
        bundlePath: bundle,
      })]);
      expect((await stat(bundle)).size).toBeGreaterThan(0);

      const importedHead = await fetchGitBundleIntoLocalRef({
        localDir: host,
        bundlePath: bundle,
        exportRef,
        importedRef,
        baseSha,
      });
      expect(importedHead).toBe(sandboxHead);
      // The host received the local-only commit and its parent (the merge-base).
      expect(await git(host, ["cat-file", "-e", `${sandboxHead}^{commit}`])).toBe("");
    } finally {
      await deleteLocalGitRef({ localDir: host, ref: importedRef });
    }
  });

  it("re-exports a full bundle that imports when the host holds neither baseSha nor the merge-base", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-ancestor-"));
    cleanupDirs.push(rootDir);
    // Host was reset to a strict ancestor of the eventual merge-base: it holds
    // only the very first commit, not baseSha and not the fork point.
    const host = await createRepo(rootDir);
    const ancestor = await git(host, ["rev-parse", "HEAD"]);

    const sandbox = path.join(rootDir, "sandbox");
    await git(rootDir, ["clone", host, sandbox]);
    await git(sandbox, ["config", "user.name", "Paperclip Remote"]);
    await git(sandbox, ["config", "user.email", "remote@paperclip.dev"]);
    // Advance the merge-base past the host, then baseSha past that, then a
    // divergent local commit — so merge-base(baseSha, HEAD) is itself a commit
    // the host does not hold.
    await writeFile(path.join(sandbox, "fork.txt"), "fork\n", "utf8");
    await git(sandbox, ["add", "-A"]);
    await git(sandbox, ["commit", "-m", "fork point"]);
    const forkPoint = await git(sandbox, ["rev-parse", "HEAD"]);
    await writeFile(path.join(sandbox, "advance.txt"), "advance\n", "utf8");
    await git(sandbox, ["add", "-A"]);
    await git(sandbox, ["commit", "-m", "advance"]);
    const baseSha = await git(sandbox, ["rev-parse", "HEAD"]);
    await git(sandbox, ["reset", "--hard", forkPoint]);
    await writeFile(path.join(sandbox, "local.txt"), "local\n", "utf8");
    await git(sandbox, ["add", "-A"]);
    await git(sandbox, ["commit", "-m", "local-only"]);
    const sandboxHead = await git(sandbox, ["rev-parse", "HEAD"]);

    // Host holds only the initial commit; it lacks both baseSha and the fork point.
    expect(await git(host, ["rev-parse", "HEAD"])).toBe(ancestor);
    await expect(git(host, ["cat-file", "-e", `${forkPoint}^{commit}`])).rejects.toThrow();

    const exportRef = createRemoteGitExportRef("test");
    const importedRef = createImportedGitRef("test");

    // The delta bundle (relative to the merge-base = fork point) names a
    // prerequisite the host lacks, so its import fails and is detected.
    const deltaBundle = path.join(rootDir, "delta.bundle");
    await execFile("sh", ["-c", buildRemoteGitDeltaBundleScript({
      remoteDir: sandbox,
      baseSha,
      exportRef,
      bundlePath: deltaBundle,
    })]);
    let deltaError: unknown;
    try {
      await fetchGitBundleIntoLocalRef({ localDir: host, bundlePath: deltaBundle, exportRef, importedRef, baseSha });
    } catch (error) {
      deltaError = error;
    }
    expect(deltaError).toBeDefined();
    expect(isMissingGitPrerequisiteError(deltaError)).toBe(true);

    // The forced full bundle is self-contained and imports into the same host.
    const fullBundle = path.join(rootDir, "full.bundle");
    try {
      await execFile("sh", ["-c", buildRemoteGitDeltaBundleScript({
        remoteDir: sandbox,
        baseSha,
        exportRef,
        bundlePath: fullBundle,
        forceFullBundle: true,
      })]);
      const importedHead = await fetchGitBundleIntoLocalRef({
        localDir: host,
        bundlePath: fullBundle,
        exportRef,
        importedRef,
        baseSha,
      });
      expect(importedHead).toBe(sandboxHead);
    } finally {
      await deleteLocalGitRef({ localDir: host, ref: importedRef });
    }
  });

  it("falls back to a full self-contained bundle when the sandbox lacks baseSha", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-full-"));
    cleanupDirs.push(rootDir);
    const sandbox = await createRepo(rootDir);
    await writeFile(path.join(sandbox, "more.txt"), "more\n", "utf8");
    await git(sandbox, ["add", "-A"]);
    await git(sandbox, ["commit", "-m", "more"]);
    const sandboxHead = await git(sandbox, ["rev-parse", "HEAD"]);

    // A fresh, unrelated host that shares no history with the sandbox.
    const host = path.join(rootDir, "fresh-host");
    await mkdir(host, { recursive: true });
    await git(host, ["init"]);

    const bundle = path.join(rootDir, "full.bundle");
    const exportRef = createRemoteGitExportRef("test");
    const importedRef = createImportedGitRef("test");
    try {
      await execFile("sh", ["-c", buildRemoteGitDeltaBundleScript({
        remoteDir: sandbox,
        // A base the sandbox does not have forces the full-bundle fallback.
        baseSha: "0000000000000000000000000000000000000000",
        exportRef,
        bundlePath: bundle,
      })]);
      expect((await stat(bundle)).size).toBeGreaterThan(0);

      const importedHead = await fetchGitBundleIntoLocalRef({
        localDir: host,
        bundlePath: bundle,
        exportRef,
        importedRef,
        baseSha: "0000000000000000000000000000000000000000",
      });
      expect(importedHead).toBe(sandboxHead);
    } finally {
      await deleteLocalGitRef({ localDir: host, ref: importedRef });
    }
  });

  it("creates the concurrent-history merge commit with a deterministic identity", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-merge-identity-"));
    cleanupDirs.push(rootDir);
    // No repo-local user.name/user.email on purpose: execution hosts are
    // containers without git config, where commit-tree cannot auto-detect an
    // identity. Setup commits pass their identity inline so only the merge
    // commit under test depends on the sync-supplied identity.
    const setupIdentity = ["-c", "user.name=Setup", "-c", "user.email=setup@paperclip.dev"];
    const repo = path.join(rootDir, "repo");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init"]);
    await git(repo, ["checkout", "-b", "main"]);
    await writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await git(repo, ["add", "tracked.txt"]);
    await git(repo, [...setupIdentity, "commit", "-m", "base"]);
    const baseHead = await git(repo, ["rev-parse", "HEAD"]);

    await writeFile(path.join(repo, "local.txt"), "local\n", "utf8");
    await git(repo, ["add", "local.txt"]);
    await git(repo, [...setupIdentity, "commit", "-m", "local advance"]);
    const currentHead = await git(repo, ["rev-parse", "HEAD"]);

    await git(repo, ["checkout", "-b", "imported", baseHead]);
    await writeFile(path.join(repo, "imported.txt"), "imported\n", "utf8");
    await git(repo, ["add", "imported.txt"]);
    await git(repo, [...setupIdentity, "commit", "-m", "sandbox change"]);
    const importedHead = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "main"]);

    // Ambient identity env vars would override the `-c` flags and make the
    // assertion machine-dependent, so clear them for the call under test.
    const identityEnvKeys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"];
    const savedEnv = new Map(identityEnvKeys.map((key) => [key, process.env[key]]));
    for (const key of identityEnvKeys) delete process.env[key];
    try {
      await integrateImportedGitHead({ localDir: repo, importedHead });
    } finally {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const parents = (await git(repo, ["rev-list", "--parents", "-1", "HEAD"])).split(" ");
    expect(parents.slice(1)).toEqual([currentHead, importedHead]);
    expect(await git(repo, ["log", "-1", "--format=%an|%ae|%cn|%ce"]))
      .toBe("Paperclip|noreply@paperclip.ing|Paperclip|noreply@paperclip.ing");
    expect(await git(repo, ["log", "-1", "--format=%s"]))
      .toBe(`Paperclip remote git sync merge ${importedHead.slice(0, 12)}`);
    const mergedTree = await git(repo, ["ls-tree", "--name-only", "HEAD"]);
    expect(mergedTree).toContain("local.txt");
    expect(mergedTree).toContain("imported.txt");
  });

  it("grafts an imported head onto the current head when histories share no ancestor", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-graft-"));
    cleanupDirs.push(rootDir);
    const setupIdentity = ["-c", "user.name=Setup", "-c", "user.email=setup@paperclip.dev"];
    const repo = path.join(rootDir, "repo");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init"]);
    await git(repo, ["checkout", "-b", "main"]);
    await writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await git(repo, ["add", "tracked.txt"]);
    await git(repo, [...setupIdentity, "commit", "-m", "base"]);
    const baseHead = await git(repo, ["rev-parse", "HEAD"]);

    await writeFile(path.join(repo, "local.txt"), "local\n", "utf8");
    await git(repo, ["add", "local.txt"]);
    await git(repo, [...setupIdentity, "commit", "-m", "local advance"]);
    const currentHead = await git(repo, ["rev-parse", "HEAD"]);

    // The shape a depth-1 shallow clone produces after `git commit --amend`:
    // a parentless root commit that shares no ancestor with the host history.
    const importedTree = await git(repo, ["rev-parse", `${baseHead}^{tree}`]);
    const importedHead = await git(repo, [...setupIdentity, "commit-tree", importedTree, "-m", "sandbox rewrite"]);

    await integrateImportedGitHead({ localDir: repo, importedHead });

    const parents = (await git(repo, ["rev-list", "--parents", "-1", "HEAD"])).split(" ");
    expect(parents.slice(1)).toEqual([currentHead]);
    // The imported tree is taken wholesale: no base exists to merge against.
    expect(await git(repo, ["rev-parse", "HEAD^{tree}"])).toBe(importedTree);
    expect(await git(repo, ["log", "-1", "--format=%s"])).toBe("sandbox rewrite");
    const body = await git(repo, ["log", "-1", "--format=%B"]);
    expect(body).toContain(`Paperclip remote git sync graft ${importedHead.slice(0, 12)}`);
    expect(body).toContain("shares no ancestor");
  });

  it("does not graft when merge-base fails for a reason other than missing ancestry", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-no-graft-"));
    cleanupDirs.push(rootDir);
    const setupIdentity = ["-c", "user.name=Setup", "-c", "user.email=setup@paperclip.dev"];
    const repo = path.join(rootDir, "repo");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init"]);
    await git(repo, ["checkout", "-b", "main"]);
    await writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await git(repo, ["add", "tracked.txt"]);
    await git(repo, [...setupIdentity, "commit", "-m", "base"]);
    const currentHead = await git(repo, ["rev-parse", "HEAD"]);

    // A well-formed sha the repository does not hold: merge-base fails with an
    // object error (exit 128), not the no-ancestor signal (exit 1). The graft
    // must not fire, and the integration keeps its loud failure.
    const missingHead = "0123456789abcdef0123456789abcdef01234567";
    await expect(integrateImportedGitHead({ localDir: repo, importedHead: missingHead }))
      .rejects.toThrow(/Failed to merge concurrent remote git histories/);
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(currentHead);
  });

  describe("readReferencedSourceGitIgnoredPaths", () => {
    it("returns null for a directory that is not a Git work tree", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-referenced-nogit-"));
      cleanupDirs.push(rootDir);
      const plainDir = path.join(rootDir, "plain");
      await mkdir(plainDir, { recursive: true });
      await writeFile(path.join(plainDir, "file.txt"), "body\n", "utf8");

      await expect(readReferencedSourceGitIgnoredPaths(plainDir)).resolves.toBeNull();
    });

    it("reads the repository top level and the ignored paths of a Git work tree", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-referenced-git-"));
      cleanupDirs.push(rootDir);
      const repo = await createRepo(rootDir);
      await writeFile(path.join(repo, ".gitignore"), "secret.env\nbuild/\n", "utf8");
      await writeFile(path.join(repo, "secret.env"), "TOKEN=abc\n", "utf8");
      await mkdir(path.join(repo, "build"), { recursive: true });
      await writeFile(path.join(repo, "build", "out.js"), "artifact\n", "utf8");

      const scan = await readReferencedSourceGitIgnoredPaths(repo);
      expect(scan?.toplevel).toBe(await git(repo, ["rev-parse", "--show-toplevel"]));
      expect(scan?.ignoredPaths).toEqual(["build", "secret.env"]);
    });

    it("preserves trailing whitespace in an ignored path entry", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-referenced-trailing-ws-"));
      cleanupDirs.push(rootDir);
      const repo = await createRepo(rootDir);
      // A wildcard pattern avoids the separate rule that git trims an
      // unescaped trailing space in a .gitignore pattern itself; the trailing
      // space under test lives in the matched FILE name, not the pattern.
      const paddedName = "secret.env ";
      await writeFile(path.join(repo, ".gitignore"), "secret.env*\n", "utf8");
      await writeFile(path.join(repo, paddedName), "TOKEN=abc\n", "utf8");

      const scan = await readReferencedSourceGitIgnoredPaths(repo);
      expect(scan?.ignoredPaths).toEqual([paddedName]);
    });

    it("fails closed when the parsed ignored-entry count exceeds the bound", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-referenced-bound-count-"));
      cleanupDirs.push(rootDir);
      const repo = await createRepo(rootDir);
      // Synthesize the `git ls-files --others --ignored -z` output directly,
      // rather than creating ten thousand real files, by intercepting the
      // scan at the executor seam. The parser must reject this before it
      // sorts or re-relativizes the list.
      const overLimitCount = REFERENCED_SOURCE_IGNORE_MAX_ENTRY_COUNT + 1;
      const syntheticIgnored = `${Array.from({ length: overLimitCount }, (_, index) => `entry-${index}`).join("\0")}\0`;
      setExpensiveWorkspaceGitExecutor(async (input) => {
        if (input.operation === "referenced_source.ignored_files") {
          return { stdout: syntheticIgnored, stderr: "" };
        }
        return await runLocalGit(input.localDir, [...input.args], {
          timeout: input.timeout,
          maxBuffer: input.maxBuffer,
          env: input.env,
        });
      });

      await expect(readReferencedSourceGitIgnoredPaths(repo)).rejects.toBeInstanceOf(
        ReferencedSourceIgnoreScanLimitExceededError,
      );
    });

    it("fails closed when the summed UTF-8 byte size of ignored paths exceeds the bound", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-referenced-bound-bytes-"));
      cleanupDirs.push(rootDir);
      const repo = await createRepo(rootDir);
      // One entry alone exceeds the byte bound, well under the entry-count bound.
      const hugeEntry = "a".repeat(REFERENCED_SOURCE_IGNORE_MAX_TOTAL_BYTES + 1);
      const syntheticIgnored = `${hugeEntry}\0`;
      setExpensiveWorkspaceGitExecutor(async (input) => {
        if (input.operation === "referenced_source.ignored_files") {
          return { stdout: syntheticIgnored, stderr: "" };
        }
        return await runLocalGit(input.localDir, [...input.args], {
          timeout: input.timeout,
          maxBuffer: input.maxBuffer,
          env: input.env,
        });
      });

      await expect(readReferencedSourceGitIgnoredPaths(repo)).rejects.toBeInstanceOf(
        ReferencedSourceIgnoreScanLimitExceededError,
      );
    });

    it("fails closed on the byte bound while it is still accumulating, before it would ever reach a later entry-count breach", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-referenced-bound-order-"));
      cleanupDirs.push(rootDir);
      const repo = await createRepo(rootDir);
      // Three entries alone cross the byte bound. Many more small entries
      // follow, so the FULL response also carries more than the entry-count
      // bound. A parser that fully builds the list before checking either
      // bound (post-parse) would report the entry-count breach, because it
      // checks that bound first against the whole materialized list. A
      // parser that checks both bounds while the list accumulates rejects on
      // the byte bound instead, the moment the third entry crosses it, well
      // before the count bound is ever reached.
      const oversizedEntry = "a".repeat(Math.ceil(REFERENCED_SOURCE_IGNORE_MAX_TOTAL_BYTES / 2) + 1);
      const bigEntries = Array.from({ length: 3 }, (_, index) => `${oversizedEntry}-${index}`);
      const trailingEntries = Array.from(
        { length: REFERENCED_SOURCE_IGNORE_MAX_ENTRY_COUNT + 10 },
        (_, index) => `trailing-${index}`,
      );
      const syntheticIgnored = `${[...bigEntries, ...trailingEntries].join("\0")}\0`;
      setExpensiveWorkspaceGitExecutor(async (input) => {
        if (input.operation === "referenced_source.ignored_files") {
          return { stdout: syntheticIgnored, stderr: "" };
        }
        return await runLocalGit(input.localDir, [...input.args], {
          timeout: input.timeout,
          maxBuffer: input.maxBuffer,
          env: input.env,
        });
      });

      await expect(readReferencedSourceGitIgnoredPaths(repo)).rejects.toThrow(/UTF-8 bytes/);
    });

    it("bounds the raw command-output allowance to the ignore-scan limits, not the general-purpose full-tree ceiling", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-referenced-raw-buffer-"));
      cleanupDirs.push(rootDir);
      const repo = await createRepo(rootDir);
      let observedMaxBuffer: number | undefined;
      setExpensiveWorkspaceGitExecutor(async (input) => {
        if (input.operation === "referenced_source.ignored_files") {
          observedMaxBuffer = input.maxBuffer;
        }
        return await runLocalGit(input.localDir, [...input.args], {
          timeout: input.timeout,
          maxBuffer: input.maxBuffer,
          env: input.env,
        });
      });

      await readReferencedSourceGitIgnoredPaths(repo);

      // Enough headroom for a scan within bounds to complete, but a small
      // multiple of the byte bound — not the far larger allowance the
      // anchor workspace's general-purpose full-tree reads use.
      expect(observedMaxBuffer).toBeGreaterThan(REFERENCED_SOURCE_IGNORE_MAX_TOTAL_BYTES);
      expect(observedMaxBuffer).toBeLessThan(16 * 1024 * 1024);
    });

    it("does not fail closed on a huge amount of unrelated tracked-change and untracked noise, when the ignored set itself stays in bounds", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-referenced-mixed-status-"));
      cleanupDirs.push(rootDir);
      const repo = await createRepo(rootDir);
      await writeFile(path.join(repo, ".gitignore"), "secret.env\n", "utf8");
      await writeFile(path.join(repo, "secret.env"), "TOKEN=abc\n", "utf8");

      // Many long-named, untracked, NOT-ignored files at the repository root.
      // `git status` reports one record per file (root-level files are never
      // collapsed the way an entirely untracked directory is), so this alone
      // makes the raw `git status --ignored` response exceed the raw buffer
      // bound this scan used to apply to the WHOLE response, well before the
      // parser ever got to discard these non-ignored records. The ignored set
      // above stays a single small entry throughout.
      const noiseNameLength = 220;
      const noiseFileCount = 30_000;
      const noiseNames = Array.from(
        { length: noiseFileCount },
        (_, index) => `${"n".repeat(noiseNameLength - 6)}${String(index).padStart(6, "0")}`,
      );
      const writeConcurrency = 200;
      for (let start = 0; start < noiseNames.length; start += writeConcurrency) {
        const batch = noiseNames.slice(start, start + writeConcurrency);
        await Promise.all(batch.map((name) => writeFile(path.join(repo, name), "", "utf8")));
      }

      // Confirm this test actually reproduces the reported defect precondition:
      // the raw `git status --ignored` response for this repository state is
      // larger than the 4 MiB raw buffer bound the scan used to apply to the
      // whole response, not just to the declared ignored-set limits. A large
      // explicit maxBuffer is required here only to observe that raw size;
      // the scan under test never issues this command.
      const rawStatusResult = await runLocalGit(
        repo,
        ["status", "--ignored", "--porcelain=v1", "-z", "--untracked-files=normal"],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      expect(Buffer.byteLength(rawStatusResult.stdout, "utf8")).toBeGreaterThan(REFERENCED_SOURCE_IGNORE_MAX_TOTAL_BYTES * 2);

      const scan = await readReferencedSourceGitIgnoredPaths(repo);

      expect(scan?.ignoredPaths).toEqual(["secret.env"]);
    });

    it("routes both scan commands through the registered scheduler instead of spawning git directly", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-referenced-scheduler-"));
      cleanupDirs.push(rootDir);
      const repo = await createRepo(rootDir);
      await writeFile(path.join(repo, ".gitignore"), "build/\n", "utf8");
      await mkdir(path.join(repo, "build"), { recursive: true });
      await writeFile(path.join(repo, "build", "out.js"), "artifact\n", "utf8");

      const operations: string[] = [];
      setExpensiveWorkspaceGitExecutor(async (input) => {
        operations.push(input.operation);
        return await runLocalGit(input.localDir, [...input.args], {
          timeout: input.timeout,
          maxBuffer: input.maxBuffer,
          env: input.env,
        });
      });

      const scan = await readReferencedSourceGitIgnoredPaths(repo);

      expect(scan?.ignoredPaths).toEqual(["build"]);
      // Both the toplevel probe and the ignored-paths read go through the SAME
      // process-wide admission seam the anchor workspace's expensive reads
      // use. A host process that bounds concurrent scans there also bounds
      // referenced-project scans, so a run with many referenced projects
      // cannot spawn one unbounded Git process per project.
      expect(operations.sort()).toEqual(["referenced_source.ignored_files", "referenced_source.toplevel"]);
    });

    it("carries the hardened arguments and does not inherit a poisoned GIT_CONFIG_GLOBAL", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-referenced-hardened-env-"));
      cleanupDirs.push(rootDir);
      const repo = await createRepo(rootDir);
      const badGlobalConfig = path.join(rootDir, "bad-global-gitconfig");
      await writeFile(badGlobalConfig, "this is not valid git config syntax [[[\n", "utf8");

      const priorGlobal = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = badGlobalConfig;
      try {
        // A plain invocation inherits the poisoned global config and fails to parse it.
        await expect(execFile("git", ["-C", repo, "status", "--porcelain"])).rejects.toThrow();
        // The hardened helper does not inherit GIT_CONFIG_GLOBAL from this process's
        // environment, so it succeeds regardless.
        await expect(readReferencedSourceGitIgnoredPaths(repo)).resolves.toMatchObject({ ignoredPaths: [] });
      } finally {
        if (priorGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = priorGlobal;
      }
    });

    it("neutralizes a repository-local core.fsmonitor hook", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-referenced-fsmonitor-"));
      cleanupDirs.push(rootDir);
      const repo = await createRepo(rootDir);
      const markerPath = path.join(rootDir, "pwned.txt");
      // A malicious repository-local config: a non-boolean `core.fsmonitor` value
      // is a hook COMMAND Git runs on every status-like read. `--no-optional-locks`
      // alone does not stop this; only the command-line `-c core.fsmonitor=false`
      // override does, because command-line config wins over repository config.
      await git(repo, ["config", "core.fsmonitor", `sh -c 'touch ${markerPath}; printf 1'`]);

      await readReferencedSourceGitIgnoredPaths(repo);

      await expect(stat(markerPath)).rejects.toThrow();
    });
  });
});

describe("sanitizeGitRemoteUrl", () => {
  it("strips userinfo, query, and fragment from http(s) URLs", () => {
    expect(sanitizeGitRemoteUrl("https://x-access-token:sekret@github.com/example/repo.git"))
      .toBe("https://github.com/example/repo.git");
    expect(sanitizeGitRemoteUrl("https://sekret-token@github.com/example/repo.git"))
      .toBe("https://github.com/example/repo.git");
    expect(sanitizeGitRemoteUrl("http://user:pass@git.internal/example/repo.git"))
      .toBe("http://git.internal/example/repo.git");
    expect(sanitizeGitRemoteUrl("https://github.com/example/repo.git?private_token=sekret#fragment"))
      .toBe("https://github.com/example/repo.git");
  });

  it("strips password and query from ssh-scheme URLs but keeps the username", () => {
    expect(sanitizeGitRemoteUrl("ssh://git@github.com/example/repo.git"))
      .toBe("ssh://git@github.com/example/repo.git");
    expect(sanitizeGitRemoteUrl("ssh://git:sekret@github.com/example/repo.git"))
      .toBe("ssh://git@github.com/example/repo.git");
    expect(sanitizeGitRemoteUrl("git+ssh://git@github.com/example/repo.git?key=sekret"))
      .toBe("git+ssh://git@github.com/example/repo.git");
  });

  it("keeps credential-free scp-like remotes unchanged", () => {
    expect(sanitizeGitRemoteUrl("git@github.com:example/repo.git"))
      .toBe("git@github.com:example/repo.git");
    expect(sanitizeGitRemoteUrl("https://github.com/example/repo.git"))
      .toBe("https://github.com/example/repo.git");
  });

  it("drops every shape whose credential surface is unknown", () => {
    // Filesystem paths are useless on the execution host and could leak
    // host-layout details; unknown schemes and malformed userinfo could carry
    // embedded secrets the sanitizer cannot recognize. All fail closed.
    expect(sanitizeGitRemoteUrl("/tmp/local/upstream.git")).toBeNull();
    expect(sanitizeGitRemoteUrl("ftp://user:pass@host/repo.git")).toBeNull();
    expect(sanitizeGitRemoteUrl("user:pass@host:path/repo.git")).toBeNull();
    expect(sanitizeGitRemoteUrl("host.example:path/repo.git")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(sanitizeGitRemoteUrl("")).toBeNull();
    expect(sanitizeGitRemoteUrl("   ")).toBeNull();
  });
});

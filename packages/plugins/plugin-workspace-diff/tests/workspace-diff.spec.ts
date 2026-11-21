import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginExecutionWorkspaceMetadata } from "@paperclipai/plugin-sdk";
import type { WorkspaceDiffQueryOptions } from "../src/contracts.js";
import { WORKSPACE_DIFF_CAPS, workspaceDiffService } from "../src/workspace-diff.js";

const execFileAsync = promisify(execFile);
const tempDirs = new Set<string>();

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-workspace-diff-"));
  tempDirs.add(repoRoot);
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
  await fs.writeFile(path.join(repoRoot, "tracked-staged.txt"), "alpha\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "tracked-unstaged.txt"), "bravo\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "delete-me.txt"), "charlie\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "rename-me.txt"), "delta\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await runGit(repoRoot, ["add", "."]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

function createWorkspace(cwd: string | null, overrides: Partial<PluginExecutionWorkspaceMetadata> = {}): PluginExecutionWorkspaceMetadata {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    projectId: randomUUID(),
    projectWorkspaceId: null,
    path: cwd,
    cwd,
    repoUrl: null,
    baseRef: null,
    branchName: "feature",
    providerType: "git_worktree",
    providerMetadata: null,
    ...overrides,
  };
}

function workingTreeQuery(overrides: Partial<WorkspaceDiffQueryOptions> = {}): WorkspaceDiffQueryOptions {
  return {
    view: "working-tree",
    baseRef: null,
    includeUntracked: true,
    paths: [],
    ...overrides,
  };
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("plugin workspace diff service", () => {
  it("returns staged, unstaged, renamed, deleted, untracked, binary, and oversized working-tree changes", async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(path.join(repoRoot, "tracked-staged.txt"), "alpha\nstaged\n", "utf8");
    await runGit(repoRoot, ["add", "tracked-staged.txt"]);
    await fs.writeFile(path.join(repoRoot, "tracked-unstaged.txt"), "bravo\nunstaged\n", "utf8");
    await runGit(repoRoot, ["mv", "rename-me.txt", "renamed.txt"]);
    await fs.rm(path.join(repoRoot, "delete-me.txt"));
    await fs.writeFile(path.join(repoRoot, "binary.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
    await fs.writeFile(path.join(repoRoot, "untracked.txt"), "brand new\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "empty-untracked.txt"), "", "utf8");
    await fs.writeFile(path.join(repoRoot, "oversized.txt"), "x".repeat(WORKSPACE_DIFF_CAPS.maxFileBytes + 1), "utf8");

    const diff = await workspaceDiffService().getDiff(createWorkspace(repoRoot), workingTreeQuery());
    const byPath = new Map(diff.files.map((file) => [file.path, file]));

    expect(diff.view).toBe("working-tree");
    expect(byPath.get("tracked-staged.txt")).toMatchObject({ staged: true, unstaged: false, status: "modified", additions: 1 });
    expect(byPath.get("tracked-staged.txt")?.patches.map((patch) => patch.kind)).toEqual(["staged"]);
    expect(byPath.get("tracked-unstaged.txt")).toMatchObject({ staged: false, unstaged: true, status: "modified", additions: 1 });
    expect(byPath.get("renamed.txt")).toMatchObject({ oldPath: "rename-me.txt", staged: true, status: "renamed" });
    expect(byPath.get("delete-me.txt")).toMatchObject({ unstaged: true, status: "deleted", deletions: 1 });
    expect(byPath.get("untracked.txt")).toMatchObject({ untracked: true, status: "untracked", additions: 1 });
    expect(byPath.get("untracked.txt")?.patches[0]?.patch).toContain("+brand new");
    expect(byPath.get("empty-untracked.txt")?.patches[0]?.patch).toBe([
      "diff --git a/empty-untracked.txt b/empty-untracked.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/empty-untracked.txt",
      "",
    ].join("\n"));
    expect(byPath.get("binary.bin")).toMatchObject({ binary: true, unstaged: true });
    expect(byPath.get("oversized.txt")).toMatchObject({ oversized: true, untracked: true });
    expect(diff.warnings.map((item) => item.code)).toEqual(expect.arrayContaining(["binary_file", "file_oversized"]));
  }, 20_000);

  it("returns head diffs against the requested base ref", async () => {
    const repoRoot = await createTempRepo();
    await runGit(repoRoot, ["checkout", "-b", "feature"]);
    await fs.writeFile(path.join(repoRoot, "tracked-staged.txt"), "alpha\ncommitted\n", "utf8");
    await runGit(repoRoot, ["add", "tracked-staged.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Feature change"]);

    const diff = await workspaceDiffService().getDiff(
      createWorkspace(repoRoot, { baseRef: "main" }),
      workingTreeQuery({ view: "head", includeUntracked: false }),
    );

    expect(diff.baseRef).toBe("main");
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({
      path: "tracked-staged.txt",
      staged: false,
      unstaged: false,
      untracked: false,
      additions: 1,
      deletions: 0,
    });
    expect(diff.files[0]?.patches.map((patch) => patch.kind)).toEqual(["head"]);
  }, 20_000);

  it("filters changed files by relative workspace paths", async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(path.join(repoRoot, "tracked-staged.txt"), "alpha\none\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "tracked-unstaged.txt"), "bravo\ntwo\n", "utf8");

    const diff = await workspaceDiffService().getDiff(
      createWorkspace(repoRoot),
      workingTreeQuery({ paths: ["tracked-staged.txt"] }),
    );

    expect(diff.paths).toEqual(["tracked-staged.txt"]);
    expect(diff.files.map((file) => file.path)).toEqual(["tracked-staged.txt"]);
  }, 20_000);

  it("applies output caps to large workspace responses", async () => {
    const repoRoot = await createTempRepo();
    for (let index = 0; index < WORKSPACE_DIFF_CAPS.maxFiles + 1; index += 1) {
      await fs.writeFile(path.join(repoRoot, `untracked-${String(index).padStart(3, "0")}.txt`), "", "utf8");
    }

    const diff = await workspaceDiffService().getDiff(createWorkspace(repoRoot), workingTreeQuery());

    expect(diff.files).toHaveLength(WORKSPACE_DIFF_CAPS.maxFiles);
    expect(diff.truncated).toBe(true);
    expect(diff.warnings).toContainEqual(expect.objectContaining({ code: "file_count_truncated" }));
  }, 20_000);

  it("does not follow untracked symlinks outside the repo", async () => {
    const repoRoot = await createTempRepo();
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-workspace-diff-secret-"));
    tempDirs.add(outsideDir);
    const secretContent = "external secret should not appear\n";
    const secretPath = path.join(outsideDir, "secret.txt");
    await fs.writeFile(secretPath, secretContent, "utf8");
    await fs.symlink(secretPath, path.join(repoRoot, "leak.txt"));

    const diff = await workspaceDiffService().getDiff(createWorkspace(repoRoot), workingTreeQuery());
    const leak = diff.files.find((file) => file.path === "leak.txt");
    const serialized = JSON.stringify(diff);

    expect(leak).toMatchObject({ untracked: true, status: "untracked", additions: 0, sizeBytes: null });
    expect(leak?.patches[0]).toMatchObject({
      kind: "untracked",
      patch: null,
      warnings: [expect.objectContaining({ code: "symlink_target_outside_workspace" })],
    });
    expect(diff.warnings).toContainEqual(expect.objectContaining({
      code: "symlink_target_outside_workspace",
      path: "leak.txt",
    }));
    expect(serialized).not.toContain(secretContent.trim());
  }, 20_000);

  it("surfaces missing cwd, non-git, invalid base refs, and unsafe path filters as plugin errors", async () => {
    const svc = workspaceDiffService();
    await expect(svc.getDiff(createWorkspace(null), workingTreeQuery()))
      .rejects.toMatchObject({ status: 422, details: { code: "missing_cwd" } });

    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-workspace-diff-non-git-"));
    tempDirs.add(nonGitDir);
    await expect(svc.getDiff(createWorkspace(nonGitDir), workingTreeQuery()))
      .rejects.toMatchObject({ status: 422, details: { code: "non_git_workspace" } });

    const repoRoot = await createTempRepo();
    await expect(svc.getDiff(createWorkspace(repoRoot), workingTreeQuery({ paths: ["../secret"] })))
      .rejects.toMatchObject({ status: 422, details: { code: "path_filter_invalid" } });
    await expect(svc.getDiff(createWorkspace(repoRoot), workingTreeQuery({ view: "head", baseRef: "missing-ref" })))
      .rejects.toMatchObject({ status: 422, details: { code: "base_ref_invalid" } });
  }, 20_000);

  it("preserves rename diffs and line counts for staged and head renames", async () => {
    const repoRoot = await createTempRepo();
    const initialContent = "one\ntwo\nthree\nfour\n";
    await fs.writeFile(path.join(repoRoot, "original.txt"), initialContent, "utf8");
    await runGit(repoRoot, ["add", "original.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add original file"]);
    await runGit(repoRoot, ["checkout", "-b", "feature"]);

    await runGit(repoRoot, ["mv", "original.txt", "moved.txt"]);
    const pureRenameDiff = await workspaceDiffService().getDiff(createWorkspace(repoRoot), workingTreeQuery());
    const pureRenamed = pureRenameDiff.files.find((file) => file.path === "moved.txt");

    expect(pureRenamed).toMatchObject({
      path: "moved.txt",
      oldPath: "original.txt",
      status: "renamed",
      staged: true,
      unstaged: false,
      additions: 0,
      deletions: 0,
    });
    expect(pureRenamed?.patches[0]?.patch).toContain("rename from original.txt");
    expect(pureRenamed?.patches[0]?.patch).toContain("rename to moved.txt");
    expect(pureRenamed?.patches[0]?.patch).not.toContain("new file mode");

    await fs.writeFile(path.join(repoRoot, "moved.txt"), `${initialContent}five\n`, "utf8");
    await runGit(repoRoot, ["add", "moved.txt"]);
    await fs.writeFile(path.join(repoRoot, "moved.txt"), `${initialContent}five\nsix\n`, "utf8");

    const editedRenameDiff = await workspaceDiffService().getDiff(createWorkspace(repoRoot), workingTreeQuery());
    const editedRenamed = editedRenameDiff.files.find((file) => file.path === "moved.txt");
    const stagedPatch = editedRenamed?.patches.find((patch) => patch.kind === "staged");
    const unstagedPatch = editedRenamed?.patches.find((patch) => patch.kind === "unstaged");

    expect(editedRenamed).toMatchObject({
      path: "moved.txt",
      oldPath: "original.txt",
      status: "renamed",
      staged: true,
      unstaged: true,
      additions: 2,
      deletions: 0,
    });
    expect(stagedPatch).toMatchObject({ additions: 1, deletions: 0 });
    expect(stagedPatch?.patch).toContain("rename from original.txt");
    expect(stagedPatch?.patch).toContain("rename to moved.txt");
    expect(stagedPatch?.patch).toContain("+five");
    expect(stagedPatch?.patch).not.toContain("new file mode");
    expect(unstagedPatch).toMatchObject({ additions: 1, deletions: 0 });
    expect(unstagedPatch?.patch).toContain("+six");
    expect(unstagedPatch?.patch).not.toContain("rename from");

    await runGit(repoRoot, ["add", "moved.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Rename and edit original file"]);

    const headRenameDiff = await workspaceDiffService().getDiff(
      createWorkspace(repoRoot, { baseRef: "main" }),
      workingTreeQuery({ view: "head", includeUntracked: false }),
    );
    const headRenamed = headRenameDiff.files.find((file) => file.path === "moved.txt");

    expect(headRenamed).toMatchObject({
      path: "moved.txt",
      oldPath: "original.txt",
      status: "renamed",
      additions: 2,
      deletions: 0,
    });
    expect(headRenamed?.patches[0]?.patch).toContain("rename from original.txt");
    expect(headRenamed?.patches[0]?.patch).toContain("rename to moved.txt");
    expect(headRenamed?.patches[0]?.patch).not.toContain("new file mode");
  }, 20_000);

  it("isolates a rename when oldPath becomes a directory containing other changed files", async () => {
    const repoRoot = await createTempRepo();
    await fs.writeFile(path.join(repoRoot, "foo"), "one\ntwo\nthree\nfour\n", "utf8");
    await runGit(repoRoot, ["add", "foo"]);
    await runGit(repoRoot, ["commit", "-m", "Add foo file"]);
    await runGit(repoRoot, ["checkout", "-b", "feature"]);

    await fs.rm(path.join(repoRoot, "foo"));
    await fs.mkdir(path.join(repoRoot, "foo"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "foo", "aaa"), "alpha\nbeta\ngamma\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "foo", "bar"), "one\ntwo\nthree\nfour\nfive\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "foo", "extra"), "x\ny\n", "utf8");
    await runGit(repoRoot, ["add", "-A"]);

    const stagedDiff = await workspaceDiffService().getDiff(createWorkspace(repoRoot), workingTreeQuery());
    const stagedByPath = new Map(stagedDiff.files.map((file) => [file.path, file]));
    const stagedRenamed = stagedByPath.get("foo/bar");

    expect(stagedRenamed).toMatchObject({
      path: "foo/bar",
      oldPath: "foo",
      status: "renamed",
      staged: true,
      additions: 1,
      deletions: 0,
    });
    expect(stagedRenamed?.patches[0]?.patch).toContain("rename from foo");
    expect(stagedRenamed?.patches[0]?.patch).toContain("rename to foo/bar");
    expect(stagedRenamed?.patches[0]?.patch).toContain("+five");
    expect(stagedRenamed?.patches[0]?.patch).not.toContain("foo/aaa");
    expect(stagedRenamed?.patches[0]?.patch).not.toContain("foo/extra");
    expect(stagedByPath.get("foo/aaa")).toMatchObject({ status: "added", additions: 3, deletions: 0 });
    expect(stagedByPath.get("foo/extra")).toMatchObject({ status: "added", additions: 2, deletions: 0 });

    await runGit(repoRoot, ["commit", "-m", "Replace foo file with directory"]);

    const headDiff = await workspaceDiffService().getDiff(
      createWorkspace(repoRoot, { baseRef: "main" }),
      workingTreeQuery({ view: "head", includeUntracked: false }),
    );
    const headRenamed = headDiff.files.find((file) => file.path === "foo/bar");
    expect(headRenamed).toMatchObject({
      path: "foo/bar",
      oldPath: "foo",
      status: "renamed",
      additions: 1,
      deletions: 0,
    });
    expect(headRenamed?.patches[0]?.patch).toContain("rename from foo");
    expect(headRenamed?.patches[0]?.patch).toContain("rename to foo/bar");
    expect(headRenamed?.patches[0]?.patch).not.toContain("foo/aaa");
    expect(headRenamed?.patches[0]?.patch).not.toContain("foo/extra");
  }, 20_000);

  it("keeps tracked patches when diff.mnemonicPrefix or diff.noprefix is enabled", async () => {
    const repoRoot = await createTempRepo();
    await runGit(repoRoot, ["config", "diff.mnemonicPrefix", "true"]);
    await fs.writeFile(path.join(repoRoot, "tracked-unstaged.txt"), "bravo\nmnemonic\n", "utf8");

    const mnemonicDiff = await workspaceDiffService().getDiff(createWorkspace(repoRoot), workingTreeQuery());
    const mnemonicFile = mnemonicDiff.files.find((file) => file.path === "tracked-unstaged.txt");
    expect(mnemonicFile).toMatchObject({ additions: 1, deletions: 0 });
    expect(mnemonicFile?.patches[0]?.patch).toContain("diff --git a/tracked-unstaged.txt b/tracked-unstaged.txt");
    expect(mnemonicFile?.patches[0]?.patch).toContain("+mnemonic");

    await runGit(repoRoot, ["config", "diff.noprefix", "true"]);
    const noPrefixDiff = await workspaceDiffService().getDiff(createWorkspace(repoRoot), workingTreeQuery());
    const noPrefixFile = noPrefixDiff.files.find((file) => file.path === "tracked-unstaged.txt");
    expect(noPrefixFile).toMatchObject({ additions: 1, deletions: 0 });
    expect(noPrefixFile?.patches[0]?.patch).toContain("diff --git a/tracked-unstaged.txt b/tracked-unstaged.txt");
    expect(noPrefixFile?.patches[0]?.patch).toContain("+mnemonic");
  }, 20_000);

  it("scopes working-tree and head diffs to subdirectory workspaces with workspace-relative paths", async () => {
    const repoRoot = await createTempRepo();
    const appDir = path.join(repoRoot, "packages", "app");
    const otherDir = path.join(repoRoot, "packages", "other");
    await fs.mkdir(appDir, { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(path.join(appDir, "tracked.txt"), "alpha\n", "utf8");
    await fs.writeFile(path.join(appDir, "rename-me.txt"), "one\ntwo\nthree\n", "utf8");
    await fs.writeFile(path.join(appDir, "delete-me.txt"), "remove me\n", "utf8");
    await fs.writeFile(path.join(otherDir, "outside.txt"), "sibling\n", "utf8");
    await runGit(repoRoot, ["add", "."]);
    await runGit(repoRoot, ["commit", "-m", "Add monorepo subdirectories"]);
    await runGit(repoRoot, ["checkout", "-b", "feature"]);

    await fs.writeFile(path.join(appDir, "tracked.txt"), "alpha\nstaged inside app\n", "utf8");
    await runGit(repoRoot, ["add", "packages/app/tracked.txt"]);
    await runGit(repoRoot, ["mv", "packages/app/rename-me.txt", "packages/app/renamed.txt"]);
    await fs.rm(path.join(appDir, "delete-me.txt"));
    await fs.writeFile(path.join(appDir, "untracked.txt"), "hello\n", "utf8");
    await fs.writeFile(path.join(otherDir, "outside.txt"), "sibling\noutside change\n", "utf8");
    await fs.writeFile(path.join(otherDir, "outside-untracked.txt"), "ignored\n", "utf8");

    const diff = await workspaceDiffService().getDiff(createWorkspace(appDir), workingTreeQuery());
    const byPath = new Map(diff.files.map((file) => [file.path, file]));

    expect(diff.files.map((file) => file.path)).toEqual([
      "delete-me.txt",
      "renamed.txt",
      "tracked.txt",
      "untracked.txt",
    ]);
    expect(byPath.get("tracked.txt")).toMatchObject({
      staged: true,
      unstaged: false,
      status: "modified",
      additions: 1,
      deletions: 0,
      sizeBytes: Buffer.byteLength("alpha\nstaged inside app\n", "utf8"),
    });
    expect(byPath.get("tracked.txt")?.patches[0]?.patch).toContain("+staged inside app");
    expect(byPath.get("renamed.txt")).toMatchObject({
      staged: true,
      status: "renamed",
      oldPath: "rename-me.txt",
      additions: 0,
      deletions: 0,
    });
    expect(byPath.get("renamed.txt")?.patches[0]?.patch).toContain("rename from rename-me.txt");
    expect(byPath.get("renamed.txt")?.patches[0]?.patch).toContain("rename to renamed.txt");
    expect(byPath.get("delete-me.txt")).toMatchObject({
      unstaged: true,
      status: "deleted",
      deletions: 1,
    });
    expect(byPath.get("delete-me.txt")?.patches[0]?.patch).toContain("-remove me");
    expect(byPath.get("untracked.txt")).toMatchObject({
      untracked: true,
      status: "untracked",
      additions: 1,
      sizeBytes: Buffer.byteLength("hello\n", "utf8"),
    });
    expect(byPath.get("untracked.txt")?.patches[0]?.patch).toContain("+hello");

    const filteredDiff = await workspaceDiffService().getDiff(
      createWorkspace(appDir),
      workingTreeQuery({ paths: ["tracked.txt"] }),
    );
    expect(filteredDiff.files.map((file) => file.path)).toEqual(["tracked.txt"]);
    expect(filteredDiff.files[0]?.patches[0]?.patch).toContain("+staged inside app");

    await runGit(repoRoot, ["add", "-A"]);
    await runGit(repoRoot, ["commit", "-m", "Subdirectory feature changes"]);

    const headDiff = await workspaceDiffService().getDiff(
      createWorkspace(appDir, { baseRef: "main" }),
      workingTreeQuery({ view: "head", includeUntracked: false }),
    );
    const headByPath = new Map(headDiff.files.map((file) => [file.path, file]));
    expect(headDiff.files.map((file) => file.path)).toEqual([
      "delete-me.txt",
      "renamed.txt",
      "tracked.txt",
      "untracked.txt",
    ]);
    expect(headByPath.get("tracked.txt")).toMatchObject({ additions: 1, deletions: 0 });
    expect(headByPath.get("tracked.txt")?.patches[0]?.patch).toContain("+staged inside app");
    expect(headByPath.get("renamed.txt")).toMatchObject({
      status: "renamed",
      oldPath: "rename-me.txt",
      additions: 0,
      deletions: 0,
    });
    expect(headByPath.get("renamed.txt")?.patches[0]?.patch).toContain("rename from rename-me.txt");
  }, 20_000);

  it("blocks untracked symlinks inside a subdirectory workspace that point outside the workspace", async () => {
    const repoRoot = await createTempRepo();
    const appDir = path.join(repoRoot, "packages", "app");
    const otherDir = path.join(repoRoot, "packages", "other");
    await fs.mkdir(appDir, { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });
    const siblingSecret = "sibling secret content\n";
    const siblingPath = path.join(otherDir, "secret.txt");
    await fs.writeFile(siblingPath, siblingSecret, "utf8");
    await runGit(repoRoot, ["add", "."]);
    await runGit(repoRoot, ["commit", "-m", "Add sibling file"]);
    await fs.symlink(siblingPath, path.join(appDir, "escape.txt"));

    const diff = await workspaceDiffService().getDiff(createWorkspace(appDir), workingTreeQuery());
    const escapeFile = diff.files.find((file) => file.path === "escape.txt");

    expect(escapeFile).toMatchObject({
      untracked: true,
      status: "untracked",
      additions: 0,
      sizeBytes: null,
    });
    expect(escapeFile?.patches[0]).toMatchObject({
      kind: "untracked",
      patch: null,
      warnings: [expect.objectContaining({ code: "symlink_target_outside_workspace" })],
    });
    expect(JSON.stringify(diff)).not.toContain(siblingSecret.trim());
  }, 20_000);
});

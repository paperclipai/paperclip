import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { captureRestorePoint, currentRestorePointSnapshot, sealRestorePoint } from "../services/git-restore-point.js";
import { assertReproducibleManagedCheckout } from "../services/git-workspace-restoration.js";
import { GIT_RESTORE_POINT_SCHEMA } from "../services/git-restore-point-storage.js";
import { captureGitWorkspaceContents, readManagedCheckoutContents, restoreGitWorkspaceContents } from "../services/git-workspace-contents.js";
import { managedProjectCheckoutName } from "../services/managed-project-checkout-name.js";
import { addNestedRepositoryWorktree, nestedRepositoryBaseCandidates, restoreNestedRepositoryWorktree } from "../services/nested-repository-worktrees.js";
import { captureRemoteWorkspaceDirectory, restoreRemoteWorkspaceArchive } from "../services/remote-workspace-snapshot-archive.js";

let root: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } }).trim();
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-archived-nested-")));
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it.each(["warm", "pruned", "missing-prerequisite", "ordinary-pruned"])("privately restores an archived linked checkout at a new path and keeps its files and extra history after cold restore (cache: %s)", async cache => {
  const pruned = cache !== "warm";
  const identity = { companyId: randomUUID(), workspaceId: randomUUID() }, projectId = randomUUID();
  const remote = path.join(root, "remote"), old = path.join(root, "old");
  await fs.mkdir(remote); await fs.mkdir(old);
  git(remote, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(remote, ".gitignore"), ".claude/settings.local.json\n");
  await fs.writeFile(path.join(remote, "note.txt"), "remote\n");
  git(remote, "add", "."); git(remote, "commit", "-qm", "initial");
  const initial = git(remote, "rev-parse", "HEAD");
  let upstream = initial;
  const source = { id: randomUUID(), repoUrl: pathToFileURL(remote).href, repoRef: "main", cwd: null };
  const name = managedProjectCheckoutName(source);
  const [base] = nestedRepositoryBaseCandidates({ ...identity, projectId, repoUrl: source.repoUrl });
  await fs.mkdir(path.dirname(base!), { recursive: true }); git(root, "clone", "-q", source.repoUrl, base!);
  if (pruned) {
    await fs.writeFile(path.join(remote, "remote-advance.txt"), "new prerequisite\n");
    git(remote, "add", "remote-advance.txt"); git(remote, "commit", "-qm", "advance remote");
    upstream = git(remote, "rev-parse", "HEAD");
  }
  git(base!, "checkout", "-qb", "paperclip/another-task/private");
  await fs.writeFile(path.join(base!, "other-task-only.txt"), "another task's private work\n");
  git(base!, "add", "other-task-only.txt"); git(base!, "commit", "-qm", "other task");
  const foreignCommit = git(base!, "rev-parse", "HEAD");
  git(base!, "checkout", "-q", "main");
  const oldNested = path.join(old, ".paperclip-repositories", name);
  await fs.mkdir(path.dirname(oldNested), { recursive: true });
  await addNestedRepositoryWorktree({ base: base!, cwd: oldNested, repoUrl: source.repoUrl, repoRef: source.repoRef });
  await fs.writeFile(path.join(oldNested, "note.txt"), "unpushed\n"); git(oldNested, "commit", "-qam", "saved");
  const head = git(oldNested, "rev-parse", "HEAD");
  await fs.writeFile(path.join(oldNested, "extra.txt"), "keep abandoned history\n");
  git(oldNested, "add", "extra.txt"); git(oldNested, "commit", "-qm", "extra");
  const extra = git(oldNested, "rev-parse", "HEAD"); git(oldNested, "reset", "--hard", head);
  await fs.writeFile(path.join(oldNested, "note.txt"), "staged\n"); git(oldNested, "add", "note.txt");
  await fs.writeFile(path.join(oldNested, "note.txt"), "unstaged\n");
  await fs.writeFile(path.join(base!, ".git", "info", "exclude"), "evidence/\n");
  await fs.mkdir(path.join(oldNested, "evidence"));
  await fs.writeFile(path.join(oldNested, "evidence", "repair.json"), "preserved repair\n", { mode: 0o600 });
  await fs.mkdir(path.join(oldNested, ".claude"));
  const settings = '{"env":{"SAVED":"private"}}\n';
  await fs.writeFile(path.join(oldNested, ".claude", "settings.local.json"), settings, { mode: 0o600 });
  const captured = (await captureRestorePoint({ cwd: oldNested, upstreamCommits: [upstream], preserveCommits: [extra] }))!;
  expect(captured.manifest.preserved).toContain(extra);
  const id = randomUUID(), generation = 1;
  const sealed = await sealRestorePoint(captured.payload, { ...identity, restorePointId: id, generation });
  const storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "objects")));
  const objectKey = `${identity.companyId}/git-restore-points/${identity.workspaceId}/${generation}/checkouts/${name}/${id}.pcrp`;
  await storage.putFile({ companyId: identity.companyId, namespace: "git-restore-points", originalFilename: null,
    contentType: "application/octet-stream", objectKey, body: sealed.ciphertext });
  const descriptor = await readManagedCheckoutContents(oldNested, name, source);
  const { manifest } = captured;
  const contents = await captureGitWorkspaceContents(old, identity, [{ ...descriptor, restorePoint: {
    schema: GIT_RESTORE_POINT_SCHEMA, id, objectKey, sha256: sealed.sha256, byteSize: sealed.ciphertext.length,
    key: sealed.key, generation, head: manifest.head, index: manifest.index, worktree: manifest.worktree,
    ignored: manifest.ignored, modes: manifest.modes, headOnRemote: false,
  } }]);
  const expectedSnapshot = await currentRestorePointSnapshot(oldNested);
  if (pruned) {
    expect(manifest.prerequisites).toContain(upstream);
    git(base!, "worktree", "remove", "--force", oldNested);
    git(base!, "branch", "-D", descriptor.branchName!);
    git(base!, "update-ref", "refs/remotes/origin/main", initial);
    git(base!, "reflog", "expire", "--expire=now", "--all"); git(base!, "gc", "--prune=now");
    expect(() => git(base!, "cat-file", "-e", `${upstream}^{commit}`)).toThrow();
  }
  await fs.writeFile(path.join(base!, "cache-only.txt"), "unrelated active cache files\n");
  const sourceState = () => ({ refs: git(base!, "show-ref"), worktrees: git(base!, "worktree", "list", "--porcelain"),
    status: git(base!, "status", "--porcelain"), index: git(base!, "ls-files", "--stage"), checkout: pruned ? null : git(oldNested, "status", "--porcelain") });
  const before = sourceState();
  const moved = path.join(root, "new"); await fs.mkdir(moved);
  const restore = (isolateRepositories: boolean, authorizeSource = async () => {}, cwd = moved) => restoreGitWorkspaceContents({ cwd,
    ...identity, projectId, contents, storage, isolateRepositories,
    prepareLocalSource: async () => async () => {}, resolveGitAuth: async () => null, authorizeSource });
  if (!pruned) await expect(restore(false)).rejects.toThrow("could not be restored");
  else {
    await fs.mkdir(path.join(moved, ".paperclip-repositories"), { recursive: true });
    await expect(restoreNestedRepositoryWorktree({ base: base!, cwd: path.join(moved, ".paperclip-repositories", name),
      commit: descriptor.commit, branchName: descriptor.branchName, repoRef: source.repoRef, afterAdd: async () => {} }))
      .rejects.toThrow("unowned_nested_worktree_branch");
  }
  await expect(restore(true, async () => { throw new Error("source_access_revoked"); })).rejects.toThrow("could not be restored");
  const recordedBase = contents.checkouts[0]!.worktree!.base;
  contents.checkouts[0]!.worktree!.base = remote;
  await expect(restore(true)).rejects.toThrow("could not be restored");
  contents.checkouts[0]!.worktree!.base = recordedBase;
  if (cache === "missing-prerequisite") {
    git(remote, "reset", "--hard", initial);
    git(remote, "reflog", "expire", "--expire=now", "--all"); git(remote, "gc", "--prune=now");
    await expect(restore(true)).rejects.toThrow("could not be restored");
    expect(sourceState()).toEqual(before);
    return;
  }
  if (cache === "ordinary-pruned") {
    await restore(false, undefined, old);
    expect((await fs.lstat(path.join(oldNested, ".git"))).isFile()).toBe(true);
    expect(await currentRestorePointSnapshot(oldNested)).toEqual(expectedSnapshot);
    expect(git(oldNested, "reflog", "show", "--format=%H", "HEAD").split("\n")).toContain(extra);
    return;
  }
  const other = path.join(root, "other-import"); await fs.mkdir(other);
  await Promise.all([restore(true), restore(true, undefined, other)]);
  expect(await currentRestorePointSnapshot(path.join(other, ".paperclip-repositories", name)))
    .toEqual(expectedSnapshot);
  const nested = path.join(moved, ".paperclip-repositories", name);
  expect((await fs.lstat(path.join(nested, ".git"))).isDirectory()).toBe(true);
  expect(git(nested, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/paperclip/another-task")).toBe("");
  expect(() => git(nested, "cat-file", "-e", `${foreignCommit}^{commit}`)).toThrow();
  expect(await currentRestorePointSnapshot(nested)).toEqual(expectedSnapshot);
  expect(git(nested, "symbolic-ref", "--short", "HEAD")).toBe(descriptor.branchName);
  expect(await fs.readFile(path.join(nested, ".claude", "settings.local.json"), "utf8")).toBe(settings);
  await expect(fs.access(path.join(nested, "cache-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(sourceState()).toEqual(before);
  const archivePath = path.join(root, "workspace.tar");
  const archive = await captureRemoteWorkspaceDirectory({ cwd: moved, archivePath });
  await fs.rm(old, { recursive: true }); await fs.rm(base!, { recursive: true });
  await fs.rm(moved, { recursive: true }); await fs.rm(other, { recursive: true }); await fs.rm(remote, { recursive: true });
  const cold = path.join(root, "cold");
  await restoreRemoteWorkspaceArchive({ archivePath, targetDir: cold, expectedManifestDigest: archive.manifestDigest });
  const coldNested = path.join(cold, ".paperclip-repositories", name);
  expect(git(coldNested, "rev-parse", "HEAD")).toBe(head);
  expect(git(coldNested, "show", ":note.txt")).toBe("staged");
  expect(await fs.readFile(path.join(coldNested, "note.txt"), "utf8")).toBe("unstaged\n");
  expect(await fs.readFile(path.join(coldNested, "evidence", "repair.json"), "utf8")).toBe("preserved repair\n");
  expect(await fs.readFile(path.join(coldNested, ".claude", "settings.local.json"), "utf8")).toBe(settings);
  git(coldNested, "reflog", "expire", "--expire=now", "--all"); git(coldNested, "gc", "--prune=now");
  expect(git(coldNested, "show", `${extra}:extra.txt`)).toBe("keep abandoned history");
  await expect(fs.access(path.join(coldNested, ".git", "objects", "info", "alternates"))).rejects.toMatchObject({ code: "ENOENT" });
}, 60_000);

it.each(["new", "existing"])("keeps archive-only refs out of ordinary standalone recovery (%s)", async state => {
  const identity = { companyId: randomUUID(), workspaceId: randomUUID() };
  const remote = path.join(root, "remote"), old = path.join(root, "old"), moved = path.join(root, "moved");
  await fs.mkdir(remote); await fs.mkdir(old); await fs.mkdir(moved);
  git(remote, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(remote, "note.txt"), "remote\n");
  git(remote, "add", "."); git(remote, "commit", "-qm", "initial");
  const upstream = git(remote, "rev-parse", "HEAD");
  const source = { id: randomUUID(), repoUrl: pathToFileURL(remote).href, repoRef: "main", cwd: null };
  const name = managedProjectCheckoutName(source), original = path.join(old, ".paperclip-repositories", name);
  await fs.mkdir(path.dirname(original), { recursive: true }); git(root, "clone", "-q", source.repoUrl, original);
  await fs.writeFile(path.join(original, "note.txt"), "saved local commit\n");
  git(original, "commit", "-qam", "saved local commit");
  const head = git(original, "rev-parse", "HEAD");
  await fs.writeFile(path.join(original, "abandoned.txt"), "saved extra history\n");
  git(original, "add", "abandoned.txt"); git(original, "commit", "-qm", "extra history");
  const extra = git(original, "rev-parse", "HEAD"); git(original, "reset", "--hard", head);
  const captured = (await captureRestorePoint({ cwd: original, upstreamCommits: [upstream] }))!;
  expect(captured.manifest.preserved).toContain(extra);
  const id = randomUUID(), generation = 1, sealed = await sealRestorePoint(captured.payload, { ...identity, restorePointId: id, generation });
  const storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "objects")));
  const objectKey = `${identity.companyId}/git-restore-points/${identity.workspaceId}/${generation}/checkouts/${name}/${id}.pcrp`;
  await storage.putFile({ companyId: identity.companyId, namespace: "git-restore-points", originalFilename: null,
    contentType: "application/octet-stream", objectKey, body: sealed.ciphertext });
  const { manifest } = captured;
  const descriptor = await readManagedCheckoutContents(original, name, source);
  const contents = await captureGitWorkspaceContents(old, identity, [{ ...descriptor, restorePoint: {
    schema: GIT_RESTORE_POINT_SCHEMA, id, objectKey, sha256: sealed.sha256, byteSize: sealed.ciphertext.length,
    key: sealed.key, generation, head: manifest.head, index: manifest.index, worktree: manifest.worktree,
    ignored: manifest.ignored, modes: manifest.modes, headOnRemote: false,
  } }]);
  const target = path.join(moved, ".paperclip-repositories", name);
  if (state === "existing") {
    await fs.mkdir(path.dirname(target), { recursive: true }); git(root, "clone", "-q", "--no-hardlinks", original, target);
    git(target, "remote", "set-url", "origin", source.repoUrl);
  }
  await restoreGitWorkspaceContents({ cwd: moved, ...identity, contents, storage,
    prepareLocalSource: async () => async () => {}, resolveGitAuth: async () => null, authorizeSource: async () => {} });
  expect(git(target, "for-each-ref", "--format=%(refname)", "refs/paperclip-preserved")).toBe("");
  expect(await fs.readFile(path.join(target, "note.txt"), "utf8")).toBe("saved local commit\n");
  git(target, "reflog", "expire", "--expire=now", "--all");
  git(target, "-c", "repack.updateServerInfo=false", "repack", "-Ad");
  git(target, "prune", "--expire", "now");
  await expect(assertReproducibleManagedCheckout(target, { repoUrl: source.repoUrl, resolveGitAuth: async () => null, restorePoint: true }))
    .resolves.toMatchObject({ headOnRemote: false });
});

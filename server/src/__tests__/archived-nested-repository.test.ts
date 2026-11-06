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
import { GIT_RESTORE_POINT_SCHEMA } from "../services/git-restore-point-storage.js";
import { captureGitWorkspaceContents, readManagedCheckoutContents, restoreGitWorkspaceContents } from "../services/git-workspace-contents.js";
import { managedProjectCheckoutName } from "../services/managed-project-checkout-name.js";
import { addNestedRepositoryWorktree, nestedRepositoryBaseCandidates } from "../services/nested-repository-worktrees.js";
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

it("privately restores an archived linked checkout at a new path and keeps its files and extra history after cold restore", async () => {
  const identity = { companyId: randomUUID(), workspaceId: randomUUID() }, projectId = randomUUID();
  const remote = path.join(root, "remote"), old = path.join(root, "old");
  await fs.mkdir(remote); await fs.mkdir(old);
  git(remote, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(remote, ".gitignore"), ".claude/settings.local.json\n");
  await fs.writeFile(path.join(remote, "note.txt"), "remote\n");
  git(remote, "add", "."); git(remote, "commit", "-qm", "initial");
  const upstream = git(remote, "rev-parse", "HEAD");
  const source = { id: randomUUID(), repoUrl: pathToFileURL(remote).href, repoRef: "main", cwd: null };
  const name = managedProjectCheckoutName(source);
  const [base] = nestedRepositoryBaseCandidates({ ...identity, projectId, repoUrl: source.repoUrl });
  await fs.mkdir(path.dirname(base!), { recursive: true }); git(root, "clone", "-q", source.repoUrl, base!);
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
  await fs.writeFile(path.join(base!, "cache-only.txt"), "unrelated active cache files\n");
  const sourceState = () => ({ refs: git(base!, "show-ref"), worktrees: git(base!, "worktree", "list", "--porcelain"),
    status: git(base!, "status", "--porcelain"), index: git(base!, "ls-files", "--stage"), checkout: git(oldNested, "status", "--porcelain") });
  const before = sourceState();
  const moved = path.join(root, "new"); await fs.mkdir(moved);
  const restore = (isolateRepositories: boolean, authorizeSource = async () => {}, cwd = moved) => restoreGitWorkspaceContents({ cwd,
    ...identity, projectId, contents, storage, isolateRepositories,
    prepareLocalSource: async () => async () => {}, resolveGitAuth: async () => null, authorizeSource });
  await expect(restore(false)).rejects.toThrow("could not be restored");
  await expect(restore(true, async () => { throw new Error("source_access_revoked"); })).rejects.toThrow("could not be restored");
  const recordedBase = contents.checkouts[0]!.worktree!.base;
  contents.checkouts[0]!.worktree!.base = remote;
  await expect(restore(true)).rejects.toThrow("could not be restored");
  contents.checkouts[0]!.worktree!.base = recordedBase;
  const other = path.join(root, "other-import"); await fs.mkdir(other);
  await Promise.all([restore(true), restore(true, undefined, other)]);
  expect(await currentRestorePointSnapshot(path.join(other, ".paperclip-repositories", name)))
    .toEqual(await currentRestorePointSnapshot(oldNested));
  const nested = path.join(moved, ".paperclip-repositories", name);
  expect((await fs.lstat(path.join(nested, ".git"))).isDirectory()).toBe(true);
  expect(await currentRestorePointSnapshot(nested)).toEqual(await currentRestorePointSnapshot(oldNested));
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

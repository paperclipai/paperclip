import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWorkspaceGitSourceRoots } from "./workspace-git-source-roots.js";
import { workspaceSourceIdentities } from "./workspace-source-lock.js";
import { localWorkspaceSourcePaths } from "./execution-workspace-source-roots.js";
import { resolveManagedProjectWorkspaceDir, resolvePaperclipInstanceRoot } from "../home-paths.js";
const execute = promisify(execFile);
let root: string;
const git = async (cwd: string, ...args: string[]) => execute("git", ["-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], {
  env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Source fixture", GIT_AUTHOR_EMAIL: "source@example.test", GIT_COMMITTER_NAME: "Source fixture", GIT_COMMITTER_EMAIL: "source@example.test" },
});
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-git-source-"))); });
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
async function repository(name = "repository") {
  const cwd = path.join(root, name);
  await fs.mkdir(cwd, { recursive: true }); await git(cwd, "init", "--initial-branch=main");
  await fs.writeFile(path.join(cwd, "saved.txt"), "original work\n");
  await git(cwd, "add", "."); await git(cwd, "commit", "-m", "Original");
  return cwd;
}
describe("Git physical source roots", () => {
  it("distinguishes an ignore-only fragment from Git source metadata", async () => {
    const cwd = path.join(root, "plain-task"), marker = path.join(cwd, ".git");
    await fs.mkdir(path.join(marker, "info"), { recursive: true });
    await fs.writeFile(path.join(marker, "info", "exclude"), "/.paperclip-repositories/\n");
    expect(await readWorkspaceGitSourceRoots(cwd)).toBeNull();
    for (const name of ["HEAD", "config", "commondir"]) {
      await fs.writeFile(path.join(marker, name), name === "commondir" ? ".\n" : "partial Git state\n");
      await expect(readWorkspaceGitSourceRoots(cwd)).rejects.toThrow("workspace_git_source_unproven");
      await fs.rm(path.join(marker, name));
    }
    await fs.mkdir(path.join(marker, "objects"));
    expect(await readWorkspaceGitSourceRoots(cwd)).toMatchObject({ objectDirectories: [{ path: path.join(marker, "objects") }] });
  });
  it.each([
    { cwd: "/source/a", providerRef: null, paths: ["/source/a"] },
    { cwd: null, providerRef: "/source/a", paths: ["/source/a"] },
    { cwd: "/source/a", providerRef: "/source/b", paths: ["/source/a", "/source/b"] },
    { cwd: "/source/a", providerRef: "/source/a", paths: ["/source/a"] },
  ])("retains every distinct local locator $cwd $providerRef", ({ cwd, providerRef, paths }) => {
    expect(localWorkspaceSourcePaths({ cwd, providerRef })).toEqual(paths);
  });
  it.each([false, true])("maps a configured directory symlink before strict Git inspection (%s)", async isGit => {
    vi.stubEnv("PAPERCLIP_HOME", root);
    const companyId = randomUUID(), projectId = randomUUID();
    const cwd = resolveManagedProjectWorkspaceDir({ companyId, projectId });
    await fs.mkdir(cwd, { recursive: true });
    if (isGit) await git(cwd, "init", "-q");
    const alias = path.join(root, "configured-source");
    await fs.symlink(cwd, alias);
    expect(await workspaceSourceIdentities(companyId, alias)).toMatchObject({ projectIds: [projectId], unownedPaths: [] });
    expect(await workspaceSourceIdentities(companyId, alias)).toEqual(await workspaceSourceIdentities(companyId, cwd));
    await expect(readWorkspaceGitSourceRoots(alias)).rejects.toThrow("workspace_git_source_unproven");
  });
  it("binds actual linked worktree administration and the full shared object-store root", async () => {
    const source = await repository(), cwd = path.join(root, "task worktree");
    await git(source, "worktree", "add", "-b", "task", cwd);
    const actual = await readWorkspaceGitSourceRoots(cwd);
    expect(actual).toMatchObject({ root: cwd, commonDirectory: { path: path.join(source, ".git") },
      objectDirectories: [{ path: path.join(source, ".git", "objects") }] });
    expect(actual!.gitDirectory.path.startsWith(path.join(source, ".git", "worktrees") + path.sep)).toBe(true);
    expect(actual!.metadata.map(file => path.basename(file.path)).sort()).toEqual([".git", "commondir"]);
    expect(await readWorkspaceGitSourceRoots(cwd)).toEqual(actual);
    expect(await fs.readFile(path.join(cwd, "saved.txt"), "utf8")).toBe("original work\n");
  });
  it("retains borrowed object stores instead of treating HEAD as the complete source", async () => {
    const source = await repository(), cwd = path.join(root, "borrower");
    await git(root, "clone", "--shared", source, cwd);
    const actual = await readWorkspaceGitSourceRoots(cwd);
    expect(actual!.objectDirectories.map(directory => directory.path).sort()).toEqual([
      path.join(cwd, ".git", "objects"), path.join(source, ".git", "objects"),
    ].sort());
    expect(actual!.metadata.some(file => file.path.endsWith("info/alternates"))).toBe(true);
  });
  it.each(["symlink", "fifo", "oversized", "http-alternate", "bare"] as const)("refuses unproven %s metadata", async kind => {
    const cwd = await repository();
    if (kind === "symlink") {
      await fs.rename(path.join(cwd, ".git"), path.join(cwd, "administration"));
      await fs.symlink("administration", path.join(cwd, ".git"));
    }
    if (kind === "fifo" || kind === "oversized") {
      await fs.rm(path.join(cwd, ".git"), { recursive: true });
      if (kind === "fifo") await execute("mkfifo", [path.join(cwd, ".git")]);
      else await fs.writeFile(path.join(cwd, ".git"), "x".repeat(4097));
    }
    if (kind === "http-alternate") await fs.writeFile(path.join(cwd, ".git", "objects", "info", "http-alternates"), "https://example.invalid/objects\n");
    if (kind === "bare") { await fs.rm(cwd, { recursive: true }); await git(root, "init", "--bare", cwd); }
    await expect(readWorkspaceGitSourceRoots(cwd)).rejects.toThrow("workspace_git_source_unproven");
  });
  it("changes the proof when a valid pointer selects another administration directory", async () => {
    const source = await repository(), first = path.join(root, "first"), second = path.join(root, "second");
    await git(source, "worktree", "add", "-b", "first", first);
    await git(source, "worktree", "add", "-b", "second", second);
    const before = await readWorkspaceGitSourceRoots(first);
    await fs.writeFile(path.join(first, ".git"), await fs.readFile(path.join(second, ".git")));
    const after = await readWorkspaceGitSourceRoots(first);
    expect(after!.gitDirectory).not.toEqual(before!.gitDirectory);
    expect(after!.fingerprint).not.toBe(before!.fingerprint);
  });
  it.each([false, true])("maps a managed linked source and its service subdirectory to both physical owners (%s)", async nested => {
    vi.stubEnv("PAPERCLIP_HOME", root);
    const companyId = randomUUID(), projectId = randomUUID(), sourceIssueId = randomUUID();
    const source = await repository(path.relative(root, path.join(resolvePaperclipInstanceRoot(),
      "isolated-repository-sources", companyId, sourceIssueId, "checkout")));
    const cwd = path.join(resolveManagedProjectWorkspaceDir({ companyId, projectId }), ".paperclip", "worktrees", "task");
    await fs.mkdir(path.dirname(cwd), { recursive: true });
    await git(source, "worktree", "add", "-b", "task", cwd);
    const target = nested ? path.join(cwd, "service") : cwd;
    if (nested) await fs.mkdir(target);
    const identities = await workspaceSourceIdentities(companyId, target);
    expect(identities).toMatchObject({ projectIds: [projectId], issueIds: [sourceIssueId], unownedPaths: [] });
    expect(identities.git!.commonDirectory.path).toBe(path.join(source, ".git"));
  });
  it("rejects a physical Git source owned by another company", async () => {
    vi.stubEnv("PAPERCLIP_HOME", root);
    const companyId = randomUUID(), foreignCompanyId = randomUUID();
    const source = await repository(path.relative(root, path.join(resolvePaperclipInstanceRoot(),
      "isolated-repository-sources", foreignCompanyId, randomUUID(), "checkout")));
    const cwd = resolveManagedProjectWorkspaceDir({ companyId, projectId: randomUUID() });
    await fs.mkdir(path.dirname(cwd), { recursive: true });
    await git(source, "worktree", "add", "-b", "task", cwd);
    await expect(workspaceSourceIdentities(companyId, cwd)).rejects.toThrow("workspace_source_company_mismatch");
  });
  it("keeps an external borrowed store explicitly unowned", async () => {
    vi.stubEnv("PAPERCLIP_HOME", root);
    const companyId = randomUUID(), projectId = randomUUID(), source = await repository("external");
    const cwd = resolveManagedProjectWorkspaceDir({ companyId, projectId });
    await fs.mkdir(path.dirname(cwd), { recursive: true });
    await git(root, "clone", "--shared", source, cwd);
    expect(await workspaceSourceIdentities(companyId, cwd)).toMatchObject({ projectIds: [projectId],
      unownedPaths: [path.join(source, ".git", "objects")] });
  });
  it("leaves absent and ordinary directories outside the Git proof", async () => {
    expect(await readWorkspaceGitSourceRoots(path.join(root, "absent"))).toBeNull();
    expect(await readWorkspaceGitSourceRoots(root)).toBeNull();
  });
});

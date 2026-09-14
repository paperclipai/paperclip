import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureTaskWorkspaceDataTarget, removeTaskWorkspaceData, type TaskWorkspaceDataTarget } from "./workspace-data-cleanup.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args], { timeout: 10_000 })).stdout.trim();
}
async function fixture(kind: "git_worktree" | "local_fs" = "git_worktree") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-task-data-cleanup-"))); roots.push(root);
  const project = path.join(root, "project"), workspace = path.join(root, "workspaces", "app");
  await fs.mkdir(project); await fs.mkdir(path.dirname(workspace));
  await git(project, "init", "-b", "main"); await git(project, "config", "user.name", "Runtime test"); await git(project, "config", "user.email", "runtime@example.test");
  await fs.writeFile(path.join(project, "source.txt"), "committed source"); await git(project, "add", "."); await git(project, "commit", "-m", "Initial source");
  if (kind === "git_worktree") await git(project, "worktree", "add", "-b", "runtime/app", workspace);
  else await fs.mkdir(workspace);
  const row = { id: randomUUID(), companyId: randomUUID(), mode: "isolated_workspace", providerType: kind, cwd: workspace, providerRef: workspace,
    branchName: kind === "git_worktree" ? "runtime/app" : null, metadata: { createdByRuntime: true } };
  const deletionId = randomUUID();
  const capture = () => captureTaskWorkspaceDataTarget(row, [project]);
  const remove = (target: TaskWorkspaceDataTarget, assertAuthorized = vi.fn(async () => {})) => removeTaskWorkspaceData({ companyId: row.companyId, workspaceId: row.id, deletionId, target, assertAuthorized });
  const quarantine = path.join(path.dirname(workspace), ".paperclip-service-deletions", deletionId, row.id);
  return { root, project, workspace, row, deletionId, capture, remove, quarantine };
}

describe("owned task workspace data cleanup primitive", () => {
  it.each(["git_worktree", "local_fs"] as const)("removes dirty %s files while preserving project history and symlink targets", async (kind) => {
    const f = await fixture(kind);
    await fs.writeFile(path.join(f.workspace, "dirty.txt"), "uncommitted app source");
    await fs.mkdir(path.join(f.workspace, "node_modules")); await fs.writeFile(path.join(f.workspace, "node_modules", "dependency.txt"), "dependency");
    await fs.symlink(f.project, path.join(f.workspace, "neighbor"));
    const target = await f.capture();
    expect(await f.remove(target)).toEqual({ state: "deleted", workspaceId: f.row.id });
    await expect(fs.lstat(f.workspace)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(f.quarantine)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(f.project, "source.txt"), "utf8")).toBe("committed source");
    expect(await git(f.project, "status", "--porcelain")).toBe("");
    if (kind === "git_worktree") {
      expect(await git(f.project, "rev-parse", "runtime/app")).toBe(target.git!.head);
      expect(await git(f.project, "worktree", "list", "--porcelain")).not.toContain(f.workspace);
    }
    expect(await f.remove(target)).toEqual({ state: "deleted", workspaceId: f.row.id });
  });

  it.each(["git_worktree", "local_fs"] as const)("recovers %s after a process stops immediately following the atomic move", async (kind) => {
    const f = await fixture(kind); await fs.writeFile(path.join(f.workspace, "dirty.txt"), "retained through interruption");
    const target = await f.capture(); let calls = 0;
    await expect(f.remove(target, vi.fn(async () => { if (++calls === 3) throw new Error("Controller stopped after rename"); }))).rejects.toThrow("Controller stopped");
    await expect(fs.lstat(f.workspace)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(f.quarantine, "dirty.txt"), "utf8")).toBe("retained through interruption");
    expect(await f.remove(JSON.parse(JSON.stringify(target)))).toMatchObject({ state: "deleted" });
    expect(await fs.readFile(path.join(f.project, "source.txt"), "utf8")).toBe("committed source");
  });

  it.each(["git_worktree", "local_fs"] as const)("preserves replacement %s roots until the reviewed inode is restored", async (kind) => {
    const f = await fixture(kind); const target = await f.capture();
    const saved = `${f.workspace}-saved`, replacement = `${f.workspace}-replacement`;
    await fs.rename(f.workspace, saved); await fs.mkdir(f.workspace); await fs.writeFile(path.join(f.workspace, "new.txt"), "new source must survive");
    await expect(f.remove(target)).rejects.toThrow(/replaced|ownership path changed/);
    expect(await fs.readFile(path.join(f.workspace, "new.txt"), "utf8")).toBe("new source must survive");
    await fs.rename(f.workspace, replacement); await fs.rename(saved, f.workspace);
    await f.remove(target); expect(await fs.readFile(path.join(replacement, "new.txt"), "utf8")).toBe("new source must survive");
  });

  it("refuses shared or operator-owned directories, project infrastructure and unrecognized Git worktrees", async () => {
    const f = await fixture("local_fs");
    await expect(captureTaskWorkspaceDataTarget({ ...f.row, mode: "shared_workspace" }, [f.project])).rejects.toThrow("isolated");
    await expect(captureTaskWorkspaceDataTarget({ ...f.row, metadata: {} }, [f.project])).rejects.toThrow("not created");
    await expect(captureTaskWorkspaceDataTarget({ ...f.row, cwd: f.project, providerRef: f.project }, [f.project])).rejects.toThrow("infrastructure");
    await expect(captureTaskWorkspaceDataTarget({ ...f.row, cwd: f.root, providerRef: f.root }, [f.project])).rejects.toThrow("infrastructure");
    await expect(captureTaskWorkspaceDataTarget({ ...f.row, providerType: "git_worktree", cwd: f.project, providerRef: f.project }, [f.workspace])).rejects.toThrow("linked Git");
    await expect(captureTaskWorkspaceDataTarget(f.row, [])).rejects.toThrow("ownership path");
    await expect(captureTaskWorkspaceDataTarget({ ...f.row, metadata: { ...f.row.metadata, worktreeInstanceRoot: "/owned-instance" } }, [f.project])).rejects.toThrow("managed instance cleanup");
  });

  it("does not remove a workspace after its Git branch or linked ownership record changes", async () => {
    const f = await fixture(); const target = await f.capture();
    await git(f.workspace, "checkout", "-b", "human/changed");
    await expect(f.remove(target)).rejects.toThrow("Git identity changed");
    await git(f.workspace, "checkout", "runtime/app");
    const link = path.join(target.git!.admin.path, "gitdir"), original = await fs.readFile(link, "utf8");
    await fs.writeFile(link, `${f.project}/.git\n`);
    await expect(f.remove(target)).rejects.toThrow("belongs to another");
    await fs.writeFile(link, original); await f.remove(target);
    expect(await git(f.project, "rev-parse", "human/changed")).toBe(target.git!.head);
  });

  it("refuses changed project history and a replaced Git administrative directory", async () => {
    const f = await fixture(); const target = await f.capture();
    await fs.writeFile(path.join(f.workspace, "change.txt"), "new commit"); await git(f.workspace, "add", "."); await git(f.workspace, "commit", "-m", "Unreviewed commit");
    await expect(f.remove(target)).rejects.toThrow("Git identity changed");
    expect(await fs.readFile(path.join(f.workspace, "change.txt"), "utf8")).toBe("new commit");
    const newer = await f.capture(), admin = newer.git!.admin.path, moved = `${admin}-saved`;
    await fs.rename(admin, moved); await fs.cp(moved, admin, { recursive: true });
    await expect(f.remove(newer)).rejects.toThrow("Git identity changed");
  });

  it("rejects a symlinked root or quarantine and a changed parent directory", async () => {
    const f = await fixture("local_fs"); const target = await f.capture();
    const saved = `${f.workspace}-saved`; await fs.rename(f.workspace, saved); await fs.symlink(saved, f.workspace);
    await expect(f.remove(target)).rejects.toThrow("directory changed identity");
    await fs.unlink(f.workspace); await fs.rename(saved, f.workspace);
    await fs.symlink(f.project, path.join(target.parent.path, ".paperclip-service-deletions"));
    await expect(f.remove(target)).rejects.toThrow("directory changed identity");
    await expect(fs.lstat(path.join(f.project, f.deletionId))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.unlink(path.join(target.parent.path, ".paperclip-service-deletions"));
    await fs.rename(target.parent.path, `${target.parent.path}-saved`); await fs.mkdir(target.parent.path);
    await expect(f.remove(target)).rejects.toThrow("parent directory changed identity");
  });

  it("recovers an exact Git ownership record left after its directory was already removed", async () => {
    const f = await fixture(), target = await f.capture();
    const sibling = path.join(f.root, "sibling"); await git(f.project, "worktree", "add", "-b", "runtime/sibling", sibling);
    await fs.mkdir(path.dirname(f.quarantine), { recursive: true }); await fs.rename(f.workspace, f.quarantine);
    await git(f.quarantine, "worktree", "repair", f.quarantine);
    await fs.rm(f.quarantine, { recursive: true });
    expect(await fs.lstat(target.git!.admin.path)).toBeDefined();
    await f.remove(target);
    await expect(fs.lstat(target.git!.admin.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(f.project, "rev-parse", "runtime/app")).toBe(target.git!.head);
    expect(await fs.readFile(path.join(sibling, "source.txt"), "utf8")).toBe("committed source");
    expect(await git(f.project, "worktree", "list", "--porcelain")).toContain(sibling);
  });

  it("preserves a missing-directory Git record when it was retargeted to another branch", async () => {
    const f = await fixture(), target = await f.capture();
    await fs.mkdir(path.dirname(f.quarantine), { recursive: true }); await fs.rename(f.workspace, f.quarantine);
    await git(f.quarantine, "worktree", "repair", f.quarantine); await git(f.quarantine, "checkout", "-b", "human/retargeted");
    await fs.rm(f.quarantine, { recursive: true });
    await expect(f.remove(target)).rejects.toThrow("Git history changed");
    expect(await fs.lstat(target.git!.admin.path)).toBeDefined();
    expect(await git(f.project, "rev-parse", "human/retargeted")).toBe(target.git!.head);
  });

  it("does not treat a newly attached Git worktree as an ordinary local directory", async () => {
    const f = await fixture("local_fs"), target = await f.capture();
    await fs.writeFile(path.join(f.workspace, ".git"), `gitdir: ${f.project}/.git\n`);
    await expect(f.remove(target)).rejects.toThrow("linked Git ownership record after review");
    expect(await fs.lstat(f.workspace)).toBeDefined();
  });

  it("does not report deletion when a parent alias changes but the captured directory still exists", async () => {
    const f = await fixture("local_fs"), alias = path.join(f.root, "workspace-alias"), other = path.join(f.root, "other");
    await fs.symlink(path.dirname(f.workspace), alias); await fs.mkdir(other);
    const aliased = path.join(alias, "app");
    const target = await captureTaskWorkspaceDataTarget({ ...f.row, cwd: aliased, providerRef: aliased }, [f.project]);
    await fs.unlink(alias); await fs.symlink(other, alias);
    await expect(f.remove(target)).rejects.toThrow("ownership path changed");
    expect(await fs.lstat(f.workspace)).toBeDefined();
    await fs.unlink(alias); await fs.symlink(path.dirname(f.workspace), alias);
    await f.remove(target);
    await expect(fs.lstat(f.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires fresh authorization at destructive boundaries and keeps managed-instance cleanup explicit", async () => {
    const f = await fixture(); const target = await f.capture();
    await expect(f.remove(target, vi.fn(async () => { throw new Error("A new consumer started"); }))).rejects.toThrow("new consumer");
    await expect(removeTaskWorkspaceData({ companyId: randomUUID(), workspaceId: f.row.id, deletionId: f.deletionId, target, assertAuthorized: async () => {} })).rejects.toThrow("identity does not match");
    await fs.mkdir(path.join(f.workspace, ".paperclip")); await fs.writeFile(path.join(f.workspace, ".paperclip", ".env"), "PAPERCLIP_INSTANCE_ID=owned-app\n");
    await expect(f.capture()).rejects.toThrow("managed instance");
    await expect(f.remove(target)).rejects.toThrow("managed instance");
    expect(await fs.readFile(path.join(f.workspace, "source.txt"), "utf8")).toBe("committed source");
  });
});

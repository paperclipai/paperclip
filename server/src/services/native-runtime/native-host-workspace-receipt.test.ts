import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { captureNativeHostWorkspaceReceipt, inspectNativeHostWorkspaceReceipt, nativeHostWorkspaceReceiptSchema } from "./native-host-workspace-receipt.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-mirror-receipt-")));
  roots.push(root);
  const parent = path.join(root, "workspaces"), cwd = path.join(parent, "app");
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(path.join(cwd, "App.jsx"), "uncommitted preview source\n");
  return { root, parent, cwd };
}
async function git(cwd: string, ...args: string[]) {
  return exec("git", ["-c", "user.name=Mirror test", "-c", "user.email=mirror@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
}

describe("durable host workspace identity", () => {
  it("records the original directory and distinguishes its absence from ordinary edits", async () => {
    const f = await fixture();
    const receipt = await captureNativeHostWorkspaceReceipt(f.cwd);
    expect(nativeHostWorkspaceReceiptSchema.parse(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    expect(receipt.git).toEqual({ kind: "absent" });
    expect(JSON.stringify(receipt)).not.toContain("uncommitted preview source");
    await fs.writeFile(path.join(f.cwd, "App.jsx"), "edited while the service runs\n");
    expect(await inspectNativeHostWorkspaceReceipt(receipt, f.cwd)).toBe("present");
    await fs.rm(f.cwd, { recursive: true });
    expect(await inspectNativeHostWorkspaceReceipt(receipt, f.cwd)).toBe("missing");
    expect(await fs.readdir(f.parent)).toEqual([]);
  });

  it.each(["directory", "parent", "symlink", "broken_symlink"])("rejects a replaced %s without changing its contents", async kind => {
    const f = await fixture();
    const receipt = await captureNativeHostWorkspaceReceipt(f.cwd);
    if (kind === "parent") {
      await fs.rename(f.parent, path.join(f.root, "original-parent"));
      await fs.mkdir(f.parent);
    } else {
      await fs.rename(f.cwd, path.join(f.parent, "original-app"));
      if (kind === "directory") await fs.mkdir(f.cwd);
      else await fs.symlink(path.join(f.parent, kind === "symlink" ? "original-app" : "absent"), f.cwd);
    }
    await expect(inspectNativeHostWorkspaceReceipt(receipt, f.cwd)).rejects.toThrow();
    const original = kind === "parent" ? path.join(f.root, "original-parent", "app") : path.join(f.parent, "original-app");
    expect(await fs.readFile(path.join(original, "App.jsx"), "utf8")).toContain("uncommitted preview source");
  });

  it("retains linked-worktree administration after its working directory disappears", async () => {
    const f = await fixture(), repo = path.join(f.root, "repo");
    await fs.mkdir(repo); await git(repo, "init", "-b", "main");
    await fs.writeFile(path.join(repo, "tracked.txt"), "shared history\n");
    await git(repo, "add", "."); await git(repo, "commit", "-m", "base");
    await fs.rm(f.cwd, { recursive: true });
    await git(repo, "worktree", "add", "-b", "preview", f.cwd);
    await fs.writeFile(path.join(f.cwd, "App.jsx"), "retained dirty source\n");
    const receipt = await captureNativeHostWorkspaceReceipt(f.cwd);
    expect(receipt.git.kind).toBe("external");
    if (receipt.git.kind !== "external") throw Error("Expected worktree receipt");
    expect(receipt.git.commonDirectory?.path).toBe(path.join(repo, ".git"));
    expect(receipt.git.backPointer?.content.trim()).toBe(path.join(f.cwd, ".git"));
    await fs.rm(f.cwd, { recursive: true });
    expect(await inspectNativeHostWorkspaceReceipt(receipt, f.cwd)).toBe("missing");
    expect((await git(repo, "log", "-1", "--format=%s")).stdout.trim()).toBe("base");
    await fs.writeFile(receipt.git.backPointer!.path, path.join(f.root, "another-worktree", ".git"));
    await expect(inspectNativeHostWorkspaceReceipt(receipt, f.cwd)).rejects.toThrow();
  });

  it.each(["embedded", "external"])("records %s Git identity without configuration or credentials", async kind => {
    const f = await fixture();
    await git(f.cwd, "init", ...(kind === "external" ? ["--separate-git-dir", path.join(f.root, "git-admin")] : []));
    await git(f.cwd, "config", "remote.origin.url", "https://fixture:fixture-secret@example.invalid/repo");
    const receipt = await captureNativeHostWorkspaceReceipt(f.cwd);
    expect(receipt.git.kind).toBe(kind);
    expect(JSON.stringify(receipt)).not.toContain("fixture-secret");
    if (receipt.git.kind === "external") {
      await fs.writeFile(path.join(receipt.git.directory.path, "commondir"), "../replacement\n");
      await expect(inspectNativeHostWorkspaceReceipt(receipt, f.cwd)).rejects.toThrow();
      await fs.rm(path.join(receipt.git.directory.path, "commondir"));
    }
    await fs.rm(f.cwd, { recursive: true });
    expect(await inspectNativeHostWorkspaceReceipt(receipt, f.cwd)).toBe("missing");
  });

  it("rejects root symlinks, altered bindings and malformed receipts", async () => {
    const f = await fixture();
    const alias = path.join(f.parent, "alias"); await fs.symlink(f.cwd, alias);
    await expect(captureNativeHostWorkspaceReceipt(alias)).rejects.toThrow();
    const receipt = await captureNativeHostWorkspaceReceipt(f.cwd);
    await expect(inspectNativeHostWorkspaceReceipt(receipt, alias)).rejects.toThrow();
    await expect(inspectNativeHostWorkspaceReceipt({ ...receipt, parent: { ...receipt.parent, ino: "0" } }, f.cwd)).rejects.toThrow();
    await expect(inspectNativeHostWorkspaceReceipt({ ...receipt, directory: { ...receipt.directory, path: f.root } }, f.cwd)).rejects.toThrow();
    await expect(inspectNativeHostWorkspaceReceipt(null, f.cwd)).rejects.toThrow();
  });
});

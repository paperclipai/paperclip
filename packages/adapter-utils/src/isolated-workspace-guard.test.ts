import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertIsolatedWorkspaceSyncAllowed, isRemoteGitRepositoryUrl } from "./isolated-workspace-guard.js";

const execFile = promisify(execFileCallback);

describe("isolated workspace source guard", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("accepts an approved workspace and refuses key directories, aliases, and broad roots", async () => {
    const temp = await mkdtemp(path.join(os.homedir(), ".paperclip-isolated-workspace-"));
    cleanup.push(temp);
    const workspaceRoot = path.join(temp, "workspaces");
    const workspace = path.join(workspaceRoot, "project");
    const secretDirectory = path.join(temp, "private", "secrets");
    await mkdir(workspace, { recursive: true });
    await mkdir(secretDirectory, { recursive: true });
    await writeFile(path.join(secretDirectory, "master.key"), "synthetic-key-never-upload");
    await symlink(secretDirectory, path.join(workspaceRoot, "secret-alias"));
    const env = {
      PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME: "true",
      PAPERCLIP_SECRETS_HOST_AGENT_UID: String((process.getuid?.() ?? 0) + 1),
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: path.join(secretDirectory, "master.key"),
      PAPERCLIP_SECRETS_ALLOWED_WORKSPACE_ROOTS_JSON: JSON.stringify([workspaceRoot]),
    };

    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, env)).resolves.toBe(workspace);
    await expect(assertIsolatedWorkspaceSyncAllowed(secretDirectory, env)).rejects.toThrow(/outside/);
    await expect(assertIsolatedWorkspaceSyncAllowed(path.join(workspaceRoot, "secret-alias"), env)).rejects.toThrow(/outside/);
    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, {
      ...env,
      PAPERCLIP_SECRETS_ALLOWED_WORKSPACE_ROOTS_JSON: JSON.stringify([temp]),
    })).rejects.toThrow(/overlap/);
    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, {
      ...env,
      PAPERCLIP_SECRETS_ALLOWED_WORKSPACE_ROOTS_JSON: "[]",
    })).rejects.toThrow(/roots/);
    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, {
      ...env,
      PAPERCLIP_SECRETS_HOST_AGENT_UID: String(process.getuid?.()),
    })).rejects.toThrow(/separate/);
    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, {
      ...env,
      PAPERCLIP_SECRETS_HOST_AGENT_UID: "",
    })).rejects.toThrow(/agent UID/);

    await chmod(workspaceRoot, 0o777);
    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, env)).rejects.toThrow(/agent-immutable/);
  });

  it("admits remote Git URLs but rejects host-local clone sources", () => {
    expect(isRemoteGitRepositoryUrl("https://github.com/org/repo.git")).toBe(true);
    expect(isRemoteGitRepositoryUrl("git@github.com:org/repo.git")).toBe(true);
    expect(isRemoteGitRepositoryUrl("file:///srv/paperclip-private/repo")).toBe(false);
    expect(isRemoteGitRepositoryUrl("/srv/paperclip-private/repo")).toBe(false);
    expect(isRemoteGitRepositoryUrl("../private/repo")).toBe(false);
    expect(isRemoteGitRepositoryUrl("--upload-pack=cmd@host:path")).toBe(false);
  });

  it("checks linked worktree metadata and the common Git directory", async () => {
    const temp = await mkdtemp(path.join(os.homedir(), ".paperclip-isolated-git-worktree-"));
    cleanup.push(temp);
    const source = path.join(temp, "source");
    const workspaceRoot = path.join(temp, "workspaces");
    const workspace = path.join(workspaceRoot, "project");
    const secretDirectory = path.join(temp, "private", "secrets");
    await mkdir(source);
    await mkdir(workspaceRoot);
    await mkdir(secretDirectory, { recursive: true });
    await writeFile(path.join(secretDirectory, "master.key"), "synthetic-key-never-upload");
    const git = async (args: string[]) => execFile("git", ["-C", source, ...args]);
    await git(["init"]);
    await writeFile(path.join(source, "README.md"), "safe\n");
    await git(["add", "README.md"]);
    await git(["-c", "user.name=Paperclip Test", "-c", "user.email=test@paperclip.dev", "commit", "-m", "base"]);
    await git(["worktree", "add", "-b", "isolated-test", workspace]);
    const manyObjects = path.join(source, ".git", "objects", "scan-cost-fixture");
    await mkdir(manyObjects);
    for (let index = 0; index < 200; index += 1) {
      await writeFile(path.join(manyObjects, `entry-${index}`), "fixture");
    }
    const env = {
      PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME: "true",
      PAPERCLIP_SECRETS_HOST_AGENT_UID: String((process.getuid?.() ?? 0) + 1),
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: path.join(secretDirectory, "master.key"),
      PAPERCLIP_SECRETS_ALLOWED_WORKSPACE_ROOTS_JSON: JSON.stringify([workspaceRoot]),
    };
    const lstatSpy = vi.spyOn(fs, "lstat");
    try {
      await expect(assertIsolatedWorkspaceSyncAllowed(workspace, env)).resolves.toBe(workspace);
      const firstWalk = lstatSpy.mock.calls.filter(([candidate]) => String(candidate).startsWith(manyObjects)).length;
      expect(firstWalk).toBeGreaterThanOrEqual(200);
      await expect(assertIsolatedWorkspaceSyncAllowed(workspace, env)).resolves.toBe(workspace);
      const secondWalk = lstatSpy.mock.calls.filter(([candidate]) => String(candidate).startsWith(manyObjects)).length;
      expect(secondWalk).toBe(firstWalk);
    } finally {
      lstatSpy.mockRestore();
    }
    const configPath = path.join(source, ".git", "config");
    await chmod(configPath, 0o666);
    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, env)).rejects.toThrow(/agent-immutable Git metadata/);
    await chmod(configPath, 0o644);
    await git(["config", "core.fsmonitor", path.join(workspace, "agent-script")]);
    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, env)).rejects.toThrow(/executable or included Git config/);
    await git(["config", "--unset", "core.fsmonitor"]);
    await git(["config", "--add", "include.path", path.join(workspace, "agent-config")]);
    await expect(assertIsolatedWorkspaceSyncAllowed(workspace, env)).rejects.toThrow(/executable or included Git config/);
  });
});

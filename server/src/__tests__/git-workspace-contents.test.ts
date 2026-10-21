import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureGitWorkspaceContents,
  CLAUDE_SETTINGS_PATH,
  readManagedCheckoutContents,
  restoreGitWorkspaceContents,
  type GitWorkspaceContents,
} from "../services/git-workspace-contents.js";
import { managedProjectCheckoutName } from "../services/managed-project-checkout-name.js";

const execFile = promisify(execFileCallback);

describe("Git workspace settings preservation", () => {
  let root: string;
  let cwd: string;
  let identity: { companyId: string; workspaceId: string };
  const original = Buffer.from('{"env":{"PRIVATE_VALUE":"saved-workspace-setting"}}\n');

  async function repository(directory: string) {
    await fs.mkdir(directory, { recursive: true });
    const git = (...args: string[]) => execFile("git", ["-C", directory,
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
    { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } });
    await git("init", "--initial-branch=main");
    await fs.writeFile(path.join(directory, ".gitignore"), ".claude/settings.local.json\n.paperclip-repositories/\n");
    await git("add", ".gitignore");
    await git("commit", "-m", "Fixture");
    return directory;
  }

  async function capture() {
    const target = path.join(cwd, CLAUDE_SETTINGS_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, original, { mode: 0o600 });
    return captureGitWorkspaceContents(cwd, identity, []);
  }

  function restore(contents: GitWorkspaceContents, selectedIdentity = identity) {
    return restoreGitWorkspaceContents({ cwd, ...selectedIdentity, contents,
      resolveGitAuth: async () => null, authorizeSource: async () => {} });
  }

  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-contents-")));
    cwd = await repository(path.join(root, "work"));
    identity = { companyId: randomUUID(), workspaceId: randomUUID() };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("binds encrypted settings to their company and workspace while restoring the original bytes and mode", async () => {
    const contents = await capture();
    const target = path.join(cwd, CLAUDE_SETTINGS_PATH);
    expect(JSON.stringify(contents)).not.toContain("saved-workspace-setting");
    expect(JSON.stringify(contents)).not.toContain(original.toString("base64"));
    await fs.unlink(target);
    for (const differentIdentity of [
      { ...identity, companyId: randomUUID() },
      { ...identity, workspaceId: randomUUID() },
    ]) {
      await expect(restore(contents, differentIdentity)).rejects.toThrow("could not be restored");
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await restore(contents);
    expect(await fs.readFile(target)).toEqual(original);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  it("rejects moving the saved settings ciphertext into a nested checkout", async () => {
    const contents = await capture();
    const source = { id: randomUUID(), repoUrl: "https://example.test/project.git", repoRef: "main", cwd: null };
    const name = managedProjectCheckoutName(source);
    const nested = await repository(path.join(cwd, ".paperclip-repositories", name));
    await execFile("git", ["-C", nested, "remote", "add", "origin", source.repoUrl]);
    const checkout = await readManagedCheckoutContents(nested, name, source);
    const moved = { ...contents, settings: null, checkouts: [{ ...checkout, settings: contents.settings }] };
    await expect(restore(moved)).rejects.toThrow("could not be restored");
    await expect(fs.lstat(path.join(nested, CLAUDE_SETTINGS_PATH))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(cwd, CLAUDE_SETTINGS_PATH))).toEqual(original);
  });

  it("rejects symlinked settings files and parents without changing the links or their targets", async () => {
    const contents = await capture();
    const outside = path.join(root, "outside");
    const outsideSettings = path.join(outside, "settings.local.json");
    const outsideBytes = Buffer.from("outside workspace contents\n");
    await fs.mkdir(outside);
    await fs.writeFile(outsideSettings, outsideBytes);
    for (const linkKind of ["parent", "file"]) {
      await fs.rm(path.join(cwd, ".claude"), { recursive: true, force: true });
      const link = path.join(cwd, linkKind === "parent" ? ".claude" : CLAUDE_SETTINGS_PATH);
      if (linkKind === "file") await fs.mkdir(path.dirname(link));
      await fs.symlink(linkKind === "parent" ? outside : outsideSettings, link);
      await expect(captureGitWorkspaceContents(cwd, identity, [])).rejects.toThrow();
      await expect(restore(contents)).rejects.toThrow("could not be restored");
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(outsideSettings)).toEqual(outsideBytes);
    }
  });

  it("preserves settings exceeding the recovery size limit", async () => {
    const contents = await capture();
    const target = path.join(cwd, CLAUDE_SETTINGS_PATH);
    const oversized = Buffer.alloc(64 * 1024 + 1, "x");
    await fs.writeFile(target, oversized);
    await expect(captureGitWorkspaceContents(cwd, identity, [])).rejects.toThrow("unsupported_local_settings");
    await expect(restore(contents)).rejects.toThrow("could not be restored");
    expect(await fs.readFile(target)).toEqual(oversized);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  it("leaves conflicting settings and their permissions intact", async () => {
    const contents = await capture();
    const target = path.join(cwd, CLAUDE_SETTINGS_PATH);
    const edited = Buffer.from('{"env":{"PRIVATE_VALUE":"newer-user-setting"}}\n');
    await fs.writeFile(target, edited);
    await fs.chmod(target, 0o640);
    await expect(restore(contents)).rejects.toThrow("could not be restored");
    expect(await fs.readFile(target)).toEqual(edited);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
    expect(await fs.readdir(path.dirname(target))).toEqual(["settings.local.json"]);
  });
});

import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareManagedCodexHome, resolveManagedCodexHomeDir } from "./codex-home.js";

describe("prepareManagedCodexHome", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("symlinks auth.json in the default managed-home mode", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    cleanupDirs.push(rootDir);
    const sourceHome = path.join(rootDir, "shared-codex-home");
    const paperclipHome = path.join(rootDir, "paperclip-home");
    await mkdir(sourceHome, { recursive: true });
    await writeFile(path.join(sourceHome, "auth.json"), '{"token":"shared"}', "utf8");

    const env = {
      CODEX_HOME: sourceHome,
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_INSTANCE_ID: "fixture",
    } as NodeJS.ProcessEnv;

    const targetHome = await prepareManagedCodexHome(env, async () => {}, "company-1");
    expect(targetHome).toBe(resolveManagedCodexHomeDir(env, "company-1"));

    const authPath = path.join(targetHome, "auth.json");
    expect((await lstat(authPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(authPath, "utf8")).toBe('{"token":"shared"}');
  });

  it("copies auth.json for worktree mode and replaces legacy symlinks", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-worktree-"));
    cleanupDirs.push(rootDir);
    const sourceHome = path.join(rootDir, "shared-codex-home");
    const paperclipHome = path.join(rootDir, "paperclip-home");
    await mkdir(sourceHome, { recursive: true });
    await writeFile(path.join(sourceHome, "auth.json"), '{"token":"shared"}', "utf8");

    const env = {
      CODEX_HOME: sourceHome,
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_INSTANCE_ID: "fixture",
      PAPERCLIP_IN_WORKTREE: "1",
    } as NodeJS.ProcessEnv;

    const targetHome = resolveManagedCodexHomeDir(env, "company-1");
    await mkdir(targetHome, { recursive: true });
    await symlink(path.join(sourceHome, "auth.json"), path.join(targetHome, "auth.json"));

    await prepareManagedCodexHome(env, async () => {}, "company-1");

    const authPath = path.join(targetHome, "auth.json");
    expect((await lstat(authPath)).isSymbolicLink()).toBe(false);
    expect(await readFile(authPath, "utf8")).toBe('{"token":"shared"}');

    await writeFile(path.join(sourceHome, "auth.json"), '{"token":"rotated"}', "utf8");
    await prepareManagedCodexHome(env, async () => {}, "company-1");

    expect((await lstat(authPath)).isSymbolicLink()).toBe(false);
    expect(await readFile(authPath, "utf8")).toBe('{"token":"rotated"}');
  });
});

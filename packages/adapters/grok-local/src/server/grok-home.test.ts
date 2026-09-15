import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GROK_SYNC_ALLOWLIST, stageGrokHomeForSync } from "./grok-home.js";

describe("GROK_SYNC_ALLOWLIST", () => {
  it("holds exactly one name: auth.json", () => {
    expect(GROK_SYNC_ALLOWLIST).toEqual(["auth.json"]);
  });
});

describe("stageGrokHomeForSync", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeRoot(prefix: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(root);
    return root;
  }

  it("stages auth.json and stages no other file", async () => {
    const root = await makeRoot("paperclip-grok-stage-");
    const home = path.join(root, "grok-home");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ ok: true }), "utf8");
    // A decoy runtime file the allowlist must not pick up.
    await fs.writeFile(path.join(home, "sessions.sqlite"), "decoy", "utf8");

    const staged = await stageGrokHomeForSync(home, { runId: "run-1" });
    cleanupDirs.push(staged);

    expect(await fs.readdir(staged)).toEqual(["auth.json"]);
    expect(await fs.readFile(path.join(staged, "auth.json"), "utf8")).toBe(
      JSON.stringify({ ok: true }),
    );
  });

  it("creates the staged directory with mode 0700", async () => {
    const root = await makeRoot("paperclip-grok-stage-dir-");
    const home = path.join(root, "grok-home");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "auth.json"), "{}", "utf8");

    const staged = await stageGrokHomeForSync(home, { runId: "run-dir" });
    cleanupDirs.push(staged);

    const mode = (await fs.stat(staged)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("writes the staged auth.json with mode 0600", async () => {
    const root = await makeRoot("paperclip-grok-stage-mode-");
    const home = path.join(root, "grok-home");
    await fs.mkdir(home, { recursive: true });
    // Source file at a world-readable mode; the staged copy must still land 0600.
    await fs.writeFile(path.join(home, "auth.json"), "{}", { mode: 0o644 });

    const staged = await stageGrokHomeForSync(home, { runId: "run-mode" });
    cleanupDirs.push(staged);

    const mode = (await fs.stat(path.join(staged, "auth.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("dereferences an auth.json symlink to bytes", async () => {
    const root = await makeRoot("paperclip-grok-stage-symlink-");
    const home = path.join(root, "grok-home");
    await fs.mkdir(home, { recursive: true });
    const authSource = path.join(root, "shared-auth.json");
    await fs.writeFile(authSource, JSON.stringify({ live: "token" }), "utf8");
    await fs.symlink(authSource, path.join(home, "auth.json"));

    const staged = await stageGrokHomeForSync(home, { runId: "run-symlink" });
    cleanupDirs.push(staged);

    const stagedAuthPath = path.join(staged, "auth.json");
    expect(await fs.readFile(stagedAuthPath, "utf8")).toBe(JSON.stringify({ live: "token" }));
    // The staged copy is a real file, not a symlink into the shared source.
    expect((await fs.lstat(stagedAuthPath)).isSymbolicLink()).toBe(false);
  });

  it("treats an absent auth.json as absent", async () => {
    const root = await makeRoot("paperclip-grok-stage-absent-");
    const home = path.join(root, "grok-home");
    await fs.mkdir(home, { recursive: true });

    const staged = await stageGrokHomeForSync(home, { runId: "run-absent" });
    cleanupDirs.push(staged);

    expect(await fs.readdir(staged)).toEqual([]);
  });

  it("treats a dangling auth.json symlink as absent", async () => {
    const root = await makeRoot("paperclip-grok-stage-dangling-");
    const home = path.join(root, "grok-home");
    await fs.mkdir(home, { recursive: true });
    await fs.symlink(path.join(root, "gone", "auth.json"), path.join(home, "auth.json"));

    const staged = await stageGrokHomeForSync(home, { runId: "run-dangling" });
    cleanupDirs.push(staged);

    expect(await fs.readdir(staged)).toEqual([]);
  });

  it("removes the staged directory on an unexpected error", async () => {
    const root = await makeRoot("paperclip-grok-stage-fail-");
    const home = path.join(root, "grok-home");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "auth.json"), "{}", "utf8");

    let createdDir: string | null = null;
    const realMkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix: string, ...rest: unknown[]) => {
      const dir = await (realMkdtemp as typeof fs.mkdtemp)(prefix, ...(rest as []));
      createdDir = dir as string;
      return dir;
    });
    vi.spyOn(fs, "readFile").mockRejectedValue(
      Object.assign(new Error("boom"), { code: "EACCES" }),
    );

    await expect(stageGrokHomeForSync(home, { runId: "run-fail" })).rejects.toThrow("boom");
    expect(createdDir).not.toBeNull();
    await expect(fs.access(createdDir as unknown as string)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

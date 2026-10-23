import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GROK_SYNC_ALLOWLIST, grokHomeHasSession, stageGrokHomeForSync } from "./grok-home.js";

describe("GROK_SYNC_ALLOWLIST", () => {
  it("holds exactly one name: auth.json", () => {
    expect(GROK_SYNC_ALLOWLIST).toEqual(["auth.json"]);
  });
});

describe("stageGrokHomeForSync", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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

  async function makeIsolatedRoot(prefix: string): Promise<string> {
    // /tmp is world-writable, so an isolated source there must be rejected.
    const root = await fs.mkdtemp(path.join(process.cwd(), prefix));
    cleanupDirs.push(root);
    return root;
  }

  function enableIsolation(): void {
    const serviceUid = process.getuid?.();
    const agentUid = serviceUid === 1000 ? 1001 : 1000;
    vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
    vi.stubEnv("PAPERCLIP_SECRETS_HOST_AGENT_UID", String(agentUid));
  }

  it("starts fresh instead of throwing when private history exceeds the lookup bound", async () => {
    const root = await makeRoot("paperclip-grok-large-history-");
    const sessions = path.join(root, "sessions");
    await fs.mkdir(sessions);
    for (let offset = 0; offset < 5001; offset += 100) {
      await Promise.all(Array.from({ length: Math.min(100, 5001 - offset) }, (_, index) => fs.writeFile(path.join(sessions, `other-${offset + index}.json`), "{}")));
    }
    await expect(grokHomeHasSession(root, "requested-session")).resolves.toBe(false);
  });

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

  it.skipIf(process.platform !== "linux" || !process.getuid?.())(
    "refuses an agent-writable home before a linked synthetic key can enter an asset",
    async () => {
      enableIsolation();
      const root = await makeIsolatedRoot(".paperclip-grok-isolated-writable-");
      const privateDir = path.join(root, "private");
      const home = path.join(root, "grok-home");
      await fs.mkdir(privateDir, { mode: 0o700 });
      await fs.mkdir(home, { mode: 0o700 });
      const key = path.join(privateDir, "master.key");
      await fs.writeFile(key, "synthetic-master-key", { mode: 0o600 });
      await fs.symlink(key, path.join(home, "auth.json"));
      await fs.chmod(home, 0o777);

      let staged: string | undefined;
      const realMkdtemp = fs.mkdtemp.bind(fs);
      vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
        staged = await realMkdtemp(...args);
        return staged;
      });
      await expect(stageGrokHomeForSync(home)).rejects.toThrow(/unsafe path/);
      expect(staged).toBeDefined();
      await expect(fs.access(staged!)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform !== "linux" || !process.getuid?.())(
    "refuses a linked synthetic key even in a trusted home",
    async () => {
      enableIsolation();
      const root = await makeIsolatedRoot(".paperclip-grok-isolated-link-");
      const home = path.join(root, "grok-home");
      const privateDir = path.join(root, "private");
      await fs.mkdir(home, { mode: 0o700 });
      await fs.mkdir(privateDir, { mode: 0o700 });
      const key = path.join(privateDir, "master.key");
      await fs.writeFile(key, "synthetic-master-key", { mode: 0o600 });
      await fs.symlink(key, path.join(home, "auth.json"));

      await expect(stageGrokHomeForSync(home)).rejects.toThrow(/unsafe path/);
    },
  );

  it.skipIf(process.platform !== "linux" || !process.getuid?.())(
    "refuses an agent-writable ancestor and a group-writable auth source",
    async () => {
      enableIsolation();
      const root = await makeIsolatedRoot(".paperclip-grok-isolated-ancestor-");
      const parent = path.join(root, "parent");
      const home = path.join(parent, "grok-home");
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      const auth = path.join(home, "auth.json");
      await fs.writeFile(auth, "synthetic-auth", { mode: 0o600 });
      await fs.chmod(parent, 0o777);
      await expect(stageGrokHomeForSync(home)).rejects.toThrow(/unsafe path/);

      await fs.chmod(parent, 0o700);
      await fs.chmod(auth, 0o660);
      await expect(stageGrokHomeForSync(home)).rejects.toThrow(/unsafe path/);
    },
  );

  it.skipIf(process.platform !== "linux" || !process.getuid?.())(
    "stages a trusted service-owned auth source in isolated mode",
    async () => {
      enableIsolation();
      const root = await makeIsolatedRoot(".paperclip-grok-isolated-trusted-");
      const home = path.join(root, "grok-home");
      await fs.mkdir(home, { mode: 0o700 });
      const auth = "synthetic-trusted-auth";
      await fs.writeFile(path.join(home, "auth.json"), auth, { mode: 0o600 });

      const staged = await stageGrokHomeForSync(home);
      cleanupDirs.push(staged);
      expect(await fs.readFile(path.join(staged, "auth.json"), "utf8")).toBe(auth);
    },
  );

  it.skipIf(process.platform !== "linux" || !process.getuid?.())(
    "accepts a missing home only below trusted ancestors",
    async () => {
      enableIsolation();
      const root = await makeIsolatedRoot(".paperclip-grok-isolated-missing-");
      const parent = path.join(root, "company");
      await fs.mkdir(parent, { mode: 0o700 });
      const staged = await stageGrokHomeForSync(path.join(parent, "grok-home"));
      cleanupDirs.push(staged);
      expect(await fs.readdir(staged)).toEqual([]);

      await fs.chmod(parent, 0o777);
      await expect(stageGrokHomeForSync(path.join(parent, "grok-home"))).rejects.toThrow(/unsafe path/);
    },
  );

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

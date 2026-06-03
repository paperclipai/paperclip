import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareClaudeConfigSeed, resolvePoolAccountSeedDir } from "./claude-config.js";

describe("prepareClaudeConfigSeed", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createEnv(root: string, sourceDir: string): NodeJS.ProcessEnv {
    return {
      HOME: root,
      PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      PAPERCLIP_INSTANCE_ID: "test-instance",
      CLAUDE_CONFIG_DIR: sourceDir,
    };
  }

  it("reuses the same snapshot path when the seeded files are unchanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-seed-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);

    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(first).toBe(second);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light" }));
  });

  it("keeps an existing snapshot intact when the seeded files change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-race-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");

    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(second).not.toBe(first);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light" }));
    await expect(fs.readFile(path.join(second, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "dark" }));
  });

  it("seeds .credentials.json from the active pool account, not the shared dir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-pool-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    // Shared dir has a "wrong" credentials blob and a shared settings file.
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), '{"account":"shared"}', "utf8");
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);

    const seedDir = await prepareClaudeConfigSeed(env, onLog, "company-1", {
      accountId: "acct-A",
      credentialsJson: '{"account":"A"}',
    });

    // .credentials.json comes from the pool account ...
    await expect(fs.readFile(path.join(seedDir, ".credentials.json"), "utf8"))
      .resolves.toBe('{"account":"A"}');
    // ... while non-credential config still comes from the shared dir.
    await expect(fs.readFile(path.join(seedDir, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light" }));
  });

  it("resolves two accounts to two distinct seed dirs with distinct credentials", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-pool2-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);

    const seedA = await prepareClaudeConfigSeed(env, onLog, "company-1", {
      accountId: "acct-A",
      credentialsJson: '{"account":"A"}',
    });
    const seedB = await prepareClaudeConfigSeed(env, onLog, "company-1", {
      accountId: "acct-B",
      credentialsJson: '{"account":"B"}',
    });

    // Different account creds -> different content -> different snapshot dir (isolation holds).
    expect(seedA).not.toBe(seedB);
    await expect(fs.readFile(path.join(seedA, ".credentials.json"), "utf8")).resolves.toBe('{"account":"A"}');
    await expect(fs.readFile(path.join(seedB, ".credentials.json"), "utf8")).resolves.toBe('{"account":"B"}');
  });

  it("falls back to shared credentials when no pool account is active (backward compat)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-nopool-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), '{"account":"shared"}', "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);

    const seedDir = await prepareClaudeConfigSeed(env, onLog, "company-1");
    await expect(fs.readFile(path.join(seedDir, ".credentials.json"), "utf8"))
      .resolves.toBe('{"account":"shared"}');
  });

  it("resolvePoolAccountSeedDir is keyed by company and account", () => {
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_HOME: "/tmp/paperclip-home",
      PAPERCLIP_INSTANCE_ID: "test-instance",
    };
    const a = resolvePoolAccountSeedDir(env, "company-1", "acct-A");
    const b = resolvePoolAccountSeedDir(env, "company-1", "acct-B");
    const c = resolvePoolAccountSeedDir(env, "company-2", "acct-A");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toContain("company-1");
    expect(a).toContain("acct-A");
  });
});

import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ISOLATION_MARKER_BODY,
  ISOLATION_MARKER_FILENAME,
  prepareClaudeConfigSeed,
} from "./claude-config.js";

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

  it("writes the isolation marker into the seed and excludes personal skills/projects/history", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-isolation-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");

    // Build a realistic ~/.claude shape: auth + settings should be copied,
    // everything else (skills, projects/* memories, plans, commands, sessions,
    // history.jsonl, plugins) MUST NOT cross into the agent's isolated dir.
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "live-token" } }),
      "utf8",
    );
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "# Operator notes", "utf8");

    await fs.mkdir(path.join(sourceDir, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, "skills", "cold-email.md"),
      "# private cold email playbook",
      "utf8",
    );
    await fs.mkdir(path.join(sourceDir, "projects", "calwey", "memory"), { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, "projects", "calwey", "memory", "notes.md"),
      "# private calwey memory",
      "utf8",
    );
    await fs.writeFile(path.join(sourceDir, "history.jsonl"), `{"prompt":"private"}\n`, "utf8");
    await fs.mkdir(path.join(sourceDir, "plugins"), { recursive: true });
    await fs.mkdir(path.join(sourceDir, "commands"), { recursive: true });
    await fs.mkdir(path.join(sourceDir, "sessions"), { recursive: true });

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const sealed = await prepareClaudeConfigSeed(env, onLog, "company-1");

    // Auth + settings DID make it across.
    await expect(fs.readFile(path.join(sealed, ".credentials.json"), "utf8")).resolves.toContain(
      "live-token",
    );
    await expect(fs.readFile(path.join(sealed, "settings.json"), "utf8")).resolves.toContain("dark");
    await expect(fs.readFile(path.join(sealed, "CLAUDE.md"), "utf8")).resolves.toContain("Operator notes");

    // Personal context DID NOT.
    await expect(fs.access(path.join(sealed, "skills"))).rejects.toThrow();
    await expect(fs.access(path.join(sealed, "projects"))).rejects.toThrow();
    await expect(fs.access(path.join(sealed, "history.jsonl"))).rejects.toThrow();
    await expect(fs.access(path.join(sealed, "plugins"))).rejects.toThrow();
    await expect(fs.access(path.join(sealed, "commands"))).rejects.toThrow();
    await expect(fs.access(path.join(sealed, "sessions"))).rejects.toThrow();

    // Isolation marker is written so audits / agents can detect the sandbox.
    await expect(fs.readFile(path.join(sealed, ISOLATION_MARKER_FILENAME), "utf8")).resolves.toBe(
      ISOLATION_MARKER_BODY,
    );
  });

  it("backfills the isolation marker on an existing cached snapshot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-backfill-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");

    // Simulate an old snapshot created before the marker was added.
    await fs.rm(path.join(first, ISOLATION_MARKER_FILENAME), { force: true });
    await expect(fs.access(path.join(first, ISOLATION_MARKER_FILENAME))).rejects.toThrow();

    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");
    expect(second).toBe(first);
    await expect(fs.readFile(path.join(second, ISOLATION_MARKER_FILENAME), "utf8")).resolves.toBe(
      ISOLATION_MARKER_BODY,
    );
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
});

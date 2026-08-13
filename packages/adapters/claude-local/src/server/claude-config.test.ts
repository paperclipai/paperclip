import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOOK_RELATIVE_PATH } from "./pre-merge-gate-script.js";
import { prepareClaudeConfigSeed } from "./claude-config.js";

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

  /**
    The Paperclip-managed pre-merge hook (Control 3, MGC-2350) is injected
    into every snapshot regardless of operator-supplied settings. Build the
    expected settings.json shape for tests that just want to assert the seeded
    theme/permissions round-trip and don't care about hook contents.
   */
  function expectedSettings(snapshotDir: string, extras: Record<string, unknown>): Record<string, unknown> {
    return {
      ...extras,
      permissions: { defaultMode: "default" },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: path.join(snapshotDir, HOOK_RELATIVE_PATH),
                __paperclipManaged: true,
              },
            ],
            __paperclipManaged: true,
          },
        ],
      },
    };
  }

  it("reuses the same snapshot path when the seeded files are unchanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-seed-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      theme: "light",
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), JSON.stringify({ token: "local" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);

    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(first).toBe(second);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify(expectedSettings(first, { theme: "light" })));
    await expect(fs.access(path.join(first, ".credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
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
      .resolves.toBe(JSON.stringify(expectedSettings(first, { theme: "light" })));
    await expect(fs.readFile(path.join(second, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify(expectedSettings(second, { theme: "dark" })));
  });

  it("strips local-only settings from remote Claude config seeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-boundary-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      permissions: {
        defaultMode: "dontAsk",
        allow: ["Bash(op item *)"],
      },
      hooks: { PreToolUse: [{ matcher: "*" }] },
      mcpServers: { local: { command: "secret-local-server" } },
      permissionMode: "dontAsk",
      skipDangerousModePermissionPrompt: true,
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "settings.local.json"), JSON.stringify({
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "credentials.json"), JSON.stringify({ token: "local" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "local instructions", "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const seedDir = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const remoteSettings = JSON.parse(await fs.readFile(path.join(seedDir, "settings.json"), "utf8"));

    // The operator's user-supplied hook was stripped during sanitization, but
    // the Paperclip-managed pre-merge hook (Control 3, MGC-2350) is injected
    // back in by the adapter — verify the final seed has only the managed
    // hook entry and not the leaked `local-only-server` references.
    expect(remoteSettings.permissions).toEqual({ defaultMode: "default" });
    expect(remoteSettings.mcpServers).toBeUndefined();
    expect(remoteSettings.permissionMode).toBeUndefined();
    expect(remoteSettings.skipDangerousModePermissionPrompt).toBeUndefined();
    expect(Array.isArray(remoteSettings.hooks?.PreToolUse)).toBe(true);
    const managed = remoteSettings.hooks.PreToolUse;
    const managedEntries = managed.filter(
      (entry: Record<string, unknown>) => entry?.__paperclipManaged === true,
    );
    expect(managedEntries).toHaveLength(1);
    expect(managedEntries[0].matcher).toBe("Bash");
    expect(Array.isArray(managedEntries[0].hooks)).toBe(true);
    expect(managedEntries[0].hooks[0].type).toBe("command");
    expect(String(managedEntries[0].hooks[0].command)).toMatch(/\.paperclip-hooks\/pre-merge-gate\.sh$/);
    await expect(fs.access(path.join(seedDir, "settings.local.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(seedDir, "credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(seedDir, "CLAUDE.md"), "utf8"))
      .resolves.toBe("local instructions");
  });

  it("injects the pre-merge hook script even when no source settings.json exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-empty-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const seedDir = await prepareClaudeConfigSeed(env, onLog, "company-1");

    const settingsPath = path.join(seedDir, "settings.json");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(settings.permissions).toEqual({ defaultMode: "default" });
    const entries = (settings.hooks?.PreToolUse ?? []).filter(
      (entry: Record<string, unknown>) => entry?.__paperclipManaged === true,
    );
    expect(entries).toHaveLength(1);
    expect(String(entries[0].hooks[0].command)).toMatch(/pre-merge-gate\.sh$/);

    const scriptPath = path.join(seedDir, ".paperclip-hooks", "pre-merge-gate.sh");
    const stat = await fs.stat(scriptPath);
    expect(stat.isFile()).toBe(true);
    // mode 0o755 — executable by the agent's Bash hook handler.
    expect(stat.mode & 0o777).toBe(0o755);
    const script = await fs.readFile(scriptPath, "utf8");
    expect(script).toContain("extract_pr_number");
    expect(script).toContain("Gate #1");
    expect(script).toContain("Gate #2");
    expect(script).toContain("Gate #3");
  });

  it("re-injects the pre-merge hook on a reused snapshot without duplicating entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-reuse-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(first).toBe(second);

    const settings = JSON.parse(await fs.readFile(path.join(second, "settings.json"), "utf8"));
    const entries = (settings.hooks?.PreToolUse ?? []).filter(
      (entry: Record<string, unknown>) => entry?.__paperclipManaged === true,
    );
    expect(entries).toHaveLength(1);
  });
});

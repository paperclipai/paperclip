import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareClaudeConfigSeed,
  resolvePaperclipMcpServerStdioEntry,
  resolveTsxLoaderEntry,
  writePaperclipClaudeMcpConfig,
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
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
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
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.readFile(path.join(second, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "dark", permissions: { defaultMode: "default" } }));
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

    expect(remoteSettings.permissions).toEqual({ defaultMode: "default" });
    expect(remoteSettings.hooks).toBeUndefined();
    expect(remoteSettings.mcpServers).toBeUndefined();
    expect(remoteSettings.permissionMode).toBeUndefined();
    expect(remoteSettings.skipDangerousModePermissionPrompt).toBeUndefined();
    await expect(fs.access(path.join(seedDir, "settings.local.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(seedDir, "credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(seedDir, "CLAUDE.md"), "utf8"))
      .resolves.toBe("local instructions");
  });
});

describe("resolvePaperclipMcpServerStdioEntry", () => {
  it("resolves the built @paperclipai/mcp-server stdio bin from this workspace", async () => {
    const resolved = resolvePaperclipMcpServerStdioEntry();
    expect(resolved).not.toBeNull();
    expect(resolved?.entryPath.endsWith(path.join("mcp-server", "dist", "stdio.js"))).toBe(true);
    await expect(fs.access(resolved!.entryPath)).resolves.toBeUndefined();
    expect(resolved?.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("resolveTsxLoaderEntry", () => {
  it("resolves tsx's ESM loader from this workspace", async () => {
    const resolved = resolveTsxLoaderEntry();
    expect(resolved).not.toBeNull();
    expect(resolved?.loaderPath.endsWith(path.join("tsx", "dist", "loader.mjs"))).toBe(true);
    await expect(fs.access(resolved!.loaderPath)).resolves.toBeUndefined();
  });
});

describe("writePaperclipClaudeMcpConfig", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("writes an empty mcpServers object when there are no gateway servers and no paperclip tool", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mcp-config-"));
    cleanupDirs.push(stateDir);

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-1",
      servers: [],
    });

    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written).toEqual({ mcpServers: {} });
  });

  it("adds a stdio entry for the paperclip mcp tool alongside http gateway servers", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mcp-config-"));
    cleanupDirs.push(stateDir);

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-2",
      servers: [{ name: "gateway", url: "https://gw.example/mcp", connectionId: "conn-12345678", token: "tok" }],
      paperclipMcpTool: {
        args: ["--import", "/fake/path/tsx/dist/loader.mjs", "/fake/path/dist/stdio.js"],
        env: { PAPERCLIP_API_URL: "http://localhost:3100", PAPERCLIP_API_KEY: "jwt" },
      },
    });

    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.mcpServers.gateway).toEqual({
      type: "http",
      url: "https://gw.example/mcp",
      headers: { Authorization: "Bearer tok" },
    });
    expect(written.mcpServers.paperclip).toEqual({
      type: "stdio",
      command: "node",
      args: ["--import", "/fake/path/tsx/dist/loader.mjs", "/fake/path/dist/stdio.js"],
      env: { PAPERCLIP_API_URL: "http://localhost:3100", PAPERCLIP_API_KEY: "jwt" },
    });
  });

  it("suffixes the paperclip tool name if a gateway server is already named 'paperclip'", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mcp-config-"));
    cleanupDirs.push(stateDir);

    const configPath = await writePaperclipClaudeMcpConfig({
      stateDir,
      runId: "run-3",
      servers: [{ name: "paperclip", url: "https://gw.example/mcp", connectionId: "conn-abcdefgh", token: "tok" }],
      paperclipMcpTool: {
        args: ["/fake/path/dist/stdio.js"],
        env: {},
      },
    });

    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.mcpServers.paperclip.type).toBe("http");
    expect(written.mcpServers["paperclip-2"]).toEqual({
      type: "stdio",
      command: "node",
      args: ["/fake/path/dist/stdio.js"],
      env: {},
    });
  });
});

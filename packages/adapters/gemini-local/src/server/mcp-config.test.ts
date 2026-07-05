import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GEMINI_MANAGED_MCP_SENTINEL_KEY,
  buildGeminiMcpServersSettings,
  ensureGeminiWorkspaceGitExclude,
  parseResolvedMcpServers,
  prepareGeminiMcpSettingsAsset,
  stripGeminiWorkspaceMcpSettings,
  syncGeminiWorkspaceMcpSettings,
} from "./mcp-config.js";

describe("parseResolvedMcpServers", () => {
  it("accepts fully-resolved stdio and remote servers", () => {
    const parsed = parseResolvedMcpServers({
      linear: {
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer lin_api_123" },
      },
      files: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp"],
        env: { API_KEY: "k" },
        cwd: "/srv/files",
        timeoutMs: 30000,
      },
    });
    expect(Object.keys(parsed).sort()).toEqual(["files", "linear"]);
    expect(parsed.linear).toMatchObject({ transport: "http", url: "https://mcp.linear.app/mcp" });
    expect(parsed.files).toMatchObject({
      transport: "stdio",
      command: "npx",
      cwd: "/srv/files",
      timeoutMs: 30000,
    });
  });

  it("drops unresolved binding objects and malformed entries", () => {
    const parsed = parseResolvedMcpServers({
      unresolved: {
        transport: "http",
        url: "https://x.example/mcp",
        headers: { Authorization: { type: "secret_ref", secretId: "abc" } },
      },
      noCommand: { transport: "stdio" },
      noUrl: { transport: "sse" },
      bogus: "nope",
    });
    // unresolved header values are dropped, but the server itself survives
    expect(parsed.unresolved.headers).toEqual({});
    expect(parsed.noCommand).toBeUndefined();
    expect(parsed.noUrl).toBeUndefined();
    expect(parsed.bogus).toBeUndefined();
  });

  it("returns empty for non-object input", () => {
    expect(parseResolvedMcpServers(undefined)).toEqual({});
    expect(parseResolvedMcpServers(null)).toEqual({});
    expect(parseResolvedMcpServers([1, 2])).toEqual({});
    expect(parseResolvedMcpServers("x")).toEqual({});
  });
});

describe("buildGeminiMcpServersSettings", () => {
  it("maps canonical transports onto Gemini's settings.json fields", () => {
    const settings = buildGeminiMcpServersSettings(
      parseResolvedMcpServers({
        linear: {
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer tok" },
          timeoutMs: 15000,
        },
        events: { transport: "sse", url: "https://api.example.com/sse", headers: {} },
        files: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "files-mcp"],
          env: { ROOT: "/tmp" },
          cwd: "/srv/files",
          allowedTools: ["read_file", "list_dir"],
        },
      }),
    );
    expect(settings).toEqual({
      linear: {
        httpUrl: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer tok" },
        timeout: 15000,
        trust: true,
      },
      events: { url: "https://api.example.com/sse", trust: true },
      files: {
        command: "npx",
        args: ["-y", "files-mcp"],
        env: { ROOT: "/tmp" },
        cwd: "/srv/files",
        trust: true,
        includeTools: ["read_file", "list_dir"],
      },
    });
  });

  it("omits empty args/env/headers and always sets trust", () => {
    const settings = buildGeminiMcpServersSettings(
      parseResolvedMcpServers({
        bare: { transport: "stdio", command: "run-mcp" },
      }),
    );
    expect(settings.bare).toEqual({ command: "run-mcp", trust: true });
  });
});

describe("syncGeminiWorkspaceMcpSettings", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const makeWorkspace = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-mcp-test-"));
    cleanupDirs.push(dir);
    return dir;
  };

  const readSettings = async (cwd: string) =>
    JSON.parse(await fs.readFile(path.join(cwd, ".gemini", "settings.json"), "utf-8")) as Record<string, unknown>;

  it("returns null when there is nothing to inject and nothing stale", async () => {
    const cwd = await makeWorkspace();
    expect(await syncGeminiWorkspaceMcpSettings({ cwd, servers: {} })).toEqual(null);
    await expect(fs.access(path.join(cwd, ".gemini", "settings.json"))).rejects.toThrow();
  });

  it("merges into existing workspace settings, preserving unrelated keys and servers", async () => {
    const cwd = await makeWorkspace();
    await fs.mkdir(path.join(cwd, ".gemini"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".gemini", "settings.json"),
      JSON.stringify({
        theme: "Default",
        mcpServers: { userOwned: { command: "user-mcp" } },
      }),
      "utf-8",
    );

    const result = await syncGeminiWorkspaceMcpSettings({
      cwd,
      servers: parseResolvedMcpServers({
        linear: { transport: "http", url: "https://mcp.linear.app/mcp", headers: {} },
      }),
    });
    expect(result?.injectedNames).toEqual(["linear"]);

    const settings = await readSettings(cwd);
    expect(settings.theme).toBe("Default");
    expect(settings.mcpServers).toEqual({
      userOwned: { command: "user-mcp" },
      linear: { httpUrl: "https://mcp.linear.app/mcp", trust: true },
    });
    expect(settings[GEMINI_MANAGED_MCP_SENTINEL_KEY]).toEqual(["linear"]);
  });

  it("is idempotent and removes previously-injected servers dropped from config", async () => {
    const cwd = await makeWorkspace();
    const first = parseResolvedMcpServers({
      linear: { transport: "http", url: "https://mcp.linear.app/mcp", headers: {} },
      files: { transport: "stdio", command: "npx" },
    });
    await syncGeminiWorkspaceMcpSettings({ cwd, servers: first });
    await syncGeminiWorkspaceMcpSettings({ cwd, servers: first });
    expect(Object.keys((await readSettings(cwd)).mcpServers as Record<string, unknown>).sort()).toEqual([
      "files",
      "linear",
    ]);

    const second = parseResolvedMcpServers({
      files: { transport: "stdio", command: "npx" },
    });
    const result = await syncGeminiWorkspaceMcpSettings({ cwd, servers: second });
    expect(result?.removedStaleNames).toEqual(["linear"]);
    const settings = await readSettings(cwd);
    expect(Object.keys(settings.mcpServers as Record<string, unknown>)).toEqual(["files"]);
    expect(settings[GEMINI_MANAGED_MCP_SENTINEL_KEY]).toEqual(["files"]);
  });

  it("cleans up all managed servers and the sentinel when config becomes empty", async () => {
    const cwd = await makeWorkspace();
    await syncGeminiWorkspaceMcpSettings({
      cwd,
      servers: parseResolvedMcpServers({
        linear: { transport: "http", url: "https://mcp.linear.app/mcp", headers: {} },
      }),
    });
    await syncGeminiWorkspaceMcpSettings({ cwd, servers: {} });
    const settings = await readSettings(cwd);
    expect(settings.mcpServers).toBeUndefined();
    expect(settings[GEMINI_MANAGED_MCP_SENTINEL_KEY]).toBeUndefined();
  });
});

describe("stripGeminiWorkspaceMcpSettings", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const makeWorkspace = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-strip-test-"));
    cleanupDirs.push(dir);
    return dir;
  };

  const settingsPathFor = (cwd: string) => path.join(cwd, ".gemini", "settings.json");

  it("removes all managed servers and the sentinel, preserving unrelated keys/servers", async () => {
    const cwd = await makeWorkspace();
    await syncGeminiWorkspaceMcpSettings({
      cwd,
      servers: parseResolvedMcpServers({
        linear: {
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer lin_api_123" },
        },
      }),
    });
    // A user-owned server + unrelated key must survive the strip.
    const path0 = settingsPathFor(cwd);
    const withUser = JSON.parse(await fs.readFile(path0, "utf-8")) as Record<string, unknown>;
    withUser.theme = "Default";
    (withUser.mcpServers as Record<string, unknown>).userOwned = { command: "user-mcp" };
    await fs.writeFile(path0, JSON.stringify(withUser), "utf-8");

    const result = await stripGeminiWorkspaceMcpSettings({ cwd });
    expect(result?.removedNames).toEqual(["linear"]);
    expect(result?.deletedFile).toBe(false);

    const settings = JSON.parse(await fs.readFile(path0, "utf-8")) as Record<string, unknown>;
    expect(settings.theme).toBe("Default");
    expect(settings.mcpServers).toEqual({ userOwned: { command: "user-mcp" } });
    expect(settings[GEMINI_MANAGED_MCP_SENTINEL_KEY]).toBeUndefined();
    // No plaintext secret survives on disk.
    expect(await fs.readFile(path0, "utf-8")).not.toContain("lin_api_123");
  });

  it("deletes the file when it was solely paperclip-created", async () => {
    const cwd = await makeWorkspace();
    await syncGeminiWorkspaceMcpSettings({
      cwd,
      servers: parseResolvedMcpServers({
        linear: { transport: "http", url: "https://mcp.linear.app/mcp", headers: {} },
      }),
    });
    const result = await stripGeminiWorkspaceMcpSettings({ cwd });
    expect(result?.deletedFile).toBe(true);
    await expect(fs.access(settingsPathFor(cwd))).rejects.toThrow();
  });

  it("leaves a user-owned settings.json (no sentinel) byte-identical", async () => {
    const cwd = await makeWorkspace();
    await fs.mkdir(path.join(cwd, ".gemini"), { recursive: true });
    const original = JSON.stringify(
      { theme: "Dark", mcpServers: { userOwned: { command: "user-mcp" } } },
      null,
      2,
    );
    await fs.writeFile(settingsPathFor(cwd), original, "utf-8");
    expect(await stripGeminiWorkspaceMcpSettings({ cwd })).toBeNull();
    expect(await fs.readFile(settingsPathFor(cwd), "utf-8")).toBe(original);
  });

  it("is a no-op when there is no settings file", async () => {
    const cwd = await makeWorkspace();
    expect(await stripGeminiWorkspaceMcpSettings({ cwd })).toBeNull();
  });
});

describe("ensureGeminiWorkspaceGitExclude", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const makeWorkspace = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-exclude-test-"));
    cleanupDirs.push(dir);
    return dir;
  };

  const readExclude = async (cwd: string) =>
    fs.readFile(path.join(cwd, ".git", "info", "exclude"), "utf-8");

  it("appends the entry once and is idempotent on repeat calls", async () => {
    const cwd = await makeWorkspace();
    await fs.mkdir(path.join(cwd, ".git"), { recursive: true });

    expect(await ensureGeminiWorkspaceGitExclude({ cwd })).toBe(true);
    expect(await ensureGeminiWorkspaceGitExclude({ cwd })).toBe(false);

    const contents = await readExclude(cwd);
    expect(contents.split(/\r?\n/).filter((line) => line.trim() === ".gemini/settings.json")).toHaveLength(1);
  });

  it("preserves existing exclude entries when appending", async () => {
    const cwd = await makeWorkspace();
    await fs.mkdir(path.join(cwd, ".git", "info"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".git", "info", "exclude"), "node_modules\n", "utf-8");

    expect(await ensureGeminiWorkspaceGitExclude({ cwd })).toBe(true);
    const contents = await readExclude(cwd);
    expect(contents).toContain("node_modules");
    expect(contents).toContain(".gemini/settings.json");
  });

  it("no-ops when the workspace is not a git repo", async () => {
    const cwd = await makeWorkspace();
    expect(await ensureGeminiWorkspaceGitExclude({ cwd })).toBe(false);
    await expect(fs.access(path.join(cwd, ".git"))).rejects.toThrow();
  });

  it("follows a git-worktree .git file pointer to the real git dir", async () => {
    const cwd = await makeWorkspace();
    // Worktree layout: <cwd>/.git is a FILE pointing at the real per-worktree
    // git dir elsewhere in the repo's .git/worktrees/<name>.
    const realGitDir = path.join(cwd, "actual-git-dir");
    await fs.mkdir(realGitDir, { recursive: true });
    await fs.writeFile(path.join(cwd, ".git"), `gitdir: ${realGitDir}\n`, "utf-8");

    expect(await ensureGeminiWorkspaceGitExclude({ cwd })).toBe(true);
    expect(await ensureGeminiWorkspaceGitExclude({ cwd })).toBe(false);

    const contents = await fs.readFile(path.join(realGitDir, "info", "exclude"), "utf-8");
    expect(contents.split(/\r?\n/).filter((line) => line.trim() === ".gemini/settings.json")).toHaveLength(1);
  });
});

describe("prepareGeminiMcpSettingsAsset", () => {
  it("writes a standalone settings.json asset and cleans up", async () => {
    const prepared = await prepareGeminiMcpSettingsAsset({
      servers: parseResolvedMcpServers({
        linear: {
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer secret-token" },
        },
      }),
    });
    try {
      expect(prepared.fileName).toBe("settings.json");
      const parsed = JSON.parse(await fs.readFile(prepared.localFilePath, "utf-8")) as Record<string, unknown>;
      expect(parsed.mcpServers).toEqual({
        linear: {
          httpUrl: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer secret-token" },
          trust: true,
        },
      });
      expect(parsed[GEMINI_MANAGED_MCP_SENTINEL_KEY]).toEqual(["linear"]);
    } finally {
      await prepared.cleanup();
    }
    await expect(fs.access(prepared.localFilePath)).rejects.toThrow();
  });
});

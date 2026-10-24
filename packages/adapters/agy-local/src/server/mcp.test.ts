import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import {
  resolveAgyMcpConfigPath,
  resolveUniqueMcpServerName,
  writePaperclipAgyMcpConfig,
  stageAgyMcpConfigForSync,
  prepareAgyLocalRunMcpHome,
} from "./mcp.js";

describe("resolveAgyMcpConfigPath", () => {
  it("resolves to ~/.gemini/config/mcp_config.json based on homedir", () => {
    const configPath = resolveAgyMcpConfigPath("/custom/home", {});
    expect(configPath).toBe(path.join("/custom/home", ".gemini", "config", "mcp_config.json"));
  });

  it("prefers env.HOME when present", () => {
    const configPath = resolveAgyMcpConfigPath("/fallback/home", { HOME: "/env/home" });
    expect(configPath).toBe(path.join("/env/home", ".gemini", "config", "mcp_config.json"));
  });
});

describe("resolveUniqueMcpServerName", () => {
  it("uses server.name when there is no conflict", () => {
    const server: AdapterRuntimeMcpServer = {
      name: "Paperclip connections",
      url: "https://example.com/mcp",
      token: "secret",
      connectionId: "conn-12345678",
    };
    expect(resolveUniqueMcpServerName(server, new Set())).toBe("Paperclip connections");
  });

  it("appends connectionId slice on conflict", () => {
    const server: AdapterRuntimeMcpServer = {
      name: "github",
      url: "https://example.com/mcp",
      token: "secret",
      connectionId: "conn-12345678",
    };
    const existing = new Set(["github"]);
    expect(resolveUniqueMcpServerName(server, existing)).toBe("github-conn-123");
  });

  it("appends incremental counter on multiple collisions", () => {
    const server: AdapterRuntimeMcpServer = {
      name: "github",
      url: "https://example.com/mcp",
      token: "secret",
      connectionId: "conn-12345678",
    };
    const existing = new Set(["github", "github-conn-123"]);
    expect(resolveUniqueMcpServerName(server, existing)).toBe("github-conn-123-2");
  });
});

describe("writePaperclipAgyMcpConfig", () => {
  it("creates mcp_config.json and cleans up when no prior file existed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-test-"));
    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "Paperclip connections",
        url: "https://api.paperclip.test/mcp/connections",
        token: "tok-abc",
        connectionId: "conn-1",
      },
      {
        name: "Paperclip projects",
        url: "https://api.paperclip.test/mcp/projects",
        token: "",
        connectionId: "conn-2",
      },
    ];

    try {
      const result = await writePaperclipAgyMcpConfig({
        homedir: tempDir,
        servers,
        runId: "run-1",
      });

      expect(result.injectedServerNames).toEqual(["Paperclip connections", "Paperclip projects"]);
      expect(result.configPath).toBe(path.join(tempDir, ".gemini", "config", "mcp_config.json"));

      const content = JSON.parse(await fs.readFile(result.configPath, "utf8"));
      expect(content.mcpServers["Paperclip connections"]).toEqual({
        url: "https://api.paperclip.test/mcp/connections",
        headers: { Authorization: "Bearer tok-abc" },
      });
      expect(content.mcpServers["Paperclip projects"]).toEqual({
        url: "https://api.paperclip.test/mcp/projects",
      });

      await result.cleanup();

      // Since file was created from scratch and now empty, it should be deleted
      const exists = await fs.stat(result.configPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("preserves unmanaged user MCP servers before, during, and after cleanup", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-test-"));
    const configDir = path.join(tempDir, ".gemini", "config");
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "mcp_config.json");

    const initialConfig = {
      mcpServers: {
        codegraph: {
          command: "codegraph",
          args: ["serve", "--mcp"],
        },
        custom_http: {
          url: "https://custom.tool/mcp",
        },
      },
      otherSettings: { enabled: true },
    };
    await fs.writeFile(configPath, JSON.stringify(initialConfig, null, 2), "utf8");

    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "codegraph",
        url: "https://api.paperclip.test/mcp/gateways/codegraph",
        token: "gw-token",
        connectionId: "cg-conn-12345",
      },
    ];

    try {
      const result = await writePaperclipAgyMcpConfig({
        homedir: tempDir,
        servers,
      });

      // Avoided collision with pre-existing "codegraph"
      expect(result.injectedServerNames).toEqual(["codegraph-cg-conn-"]);

      const content = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(content.mcpServers.codegraph).toEqual(initialConfig.mcpServers.codegraph);
      expect(content.mcpServers.custom_http).toEqual(initialConfig.mcpServers.custom_http);
      expect(content.mcpServers["codegraph-cg-conn-"]).toEqual({
        url: "https://api.paperclip.test/mcp/gateways/codegraph",
        headers: { Authorization: "Bearer gw-token" },
      });
      expect(content.otherSettings).toEqual({ enabled: true });

      await result.cleanup();

      const afterCleanup = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(afterCleanup.mcpServers.codegraph).toEqual(initialConfig.mcpServers.codegraph);
      expect(afterCleanup.mcpServers.custom_http).toEqual(initialConfig.mcpServers.custom_http);
      expect(afterCleanup.mcpServers["codegraph-cg-conn-"]).toBeUndefined();
      expect(afterCleanup.otherSettings).toEqual({ enabled: true });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("refuses to overwrite an unparseable existing config", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-test-"));
    const configDir = path.join(tempDir, ".gemini", "config");
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "mcp_config.json");
    await fs.writeFile(configPath, "{ not json", "utf8");

    try {
      await expect(
        writePaperclipAgyMcpConfig({
          homedir: tempDir,
          servers: [{ name: "Paperclip connections", url: "https://api.paperclip.test/mcp", token: "", connectionId: "c1" }],
        }),
      ).rejects.toThrow(/not valid JSON/);

      // The user's file is left byte-for-byte untouched.
      expect(await fs.readFile(configPath, "utf8")).toBe("{ not json");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("refuses to overwrite an existing config whose root is not an object", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-test-"));
    const configDir = path.join(tempDir, ".gemini", "config");
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "mcp_config.json");
    await fs.writeFile(configPath, "[1, 2, 3]\n", "utf8");

    try {
      await expect(
        writePaperclipAgyMcpConfig({
          homedir: tempDir,
          servers: [{ name: "Paperclip connections", url: "https://api.paperclip.test/mcp", token: "", connectionId: "c1" }],
        }),
      ).rejects.toThrow(/not a JSON object/);

      expect(await fs.readFile(configPath, "utf8")).toBe("[1, 2, 3]\n");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("sweeps stale injected entries from earlier runs before injecting", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-test-"));
    const configDir = path.join(tempDir, ".gemini", "config");
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "mcp_config.json");

    // The user's own servers: a "Paperclip projects" that is command-shaped
    // (not an injected entry) and an unrelated custom server.
    const initialConfig = {
      mcpServers: {
        "Paperclip projects": {
          command: "my-own-projects-server",
          args: ["serve"],
        },
        custom_http: {
          url: "https://custom.tool/mcp",
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(initialConfig, null, 2), "utf8");

    try {
      // A first run injects its servers and is then hard-killed, so its
      // cleanup never runs. The writer records ownership of what it
      // injected, and the next run may sweep exactly those entries.
      await writePaperclipAgyMcpConfig({
        homedir: tempDir,
        servers: [
          {
            name: "Paperclip connections",
            url: "https://api.paperclip.test/mcp/connections",
            token: "stale-token",
            connectionId: "conn-1",
          },
          {
            name: "Paperclip projects",
            url: "https://api.paperclip.test/mcp/projects",
            token: "stale-projects-token",
            connectionId: "conn-999",
          },
        ],
      });

      const result = await writePaperclipAgyMcpConfig({
        homedir: tempDir,
        servers: [
          {
            name: "Paperclip connections",
            url: "https://api.paperclip.test/mcp/connections",
            token: "fresh-token",
            connectionId: "conn-1",
          },
          {
            name: "Paperclip projects",
            url: "https://api.paperclip.test/mcp/projects",
            token: "fresh-projects-token",
            connectionId: "conn-2",
          },
        ],
      });

      expect(result.sweptStaleServerNames).toEqual(
        expect.arrayContaining(["Paperclip connections", "Paperclip projects-conn-999"]),
      );
      expect(result.sweptStaleServerNames).not.toContain("Paperclip projects");

      const content = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(content.mcpServers["Paperclip connections"]).toEqual({
        url: "https://api.paperclip.test/mcp/connections",
        headers: { Authorization: "Bearer fresh-token" },
      });
      // The user's own "Paperclip projects" (command-shaped) survives, so the
      // managed one lands on its connection-suffixed name.
      expect(content.mcpServers["Paperclip projects"]).toEqual(initialConfig.mcpServers["Paperclip projects"]);
      expect(content.mcpServers["Paperclip projects-conn-2"]).toEqual({
        url: "https://api.paperclip.test/mcp/projects",
        headers: { Authorization: "Bearer fresh-projects-token" },
      });
      expect(content.mcpServers["Paperclip projects-conn-999"]).toBeUndefined();
      expect(content.mcpServers.custom_http).toEqual(initialConfig.mcpServers.custom_http);

      await result.cleanup();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("serializes concurrent writes so neither run's servers are lost", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-test-"));

    try {
      const [a, b] = await Promise.all([
        writePaperclipAgyMcpConfig({
          homedir: tempDir,
          servers: [{ name: "Paperclip connections", url: "https://a.test/mcp", token: "tok-a", connectionId: "ca" }],
          runId: "run-a",
        }),
        writePaperclipAgyMcpConfig({
          homedir: tempDir,
          servers: [{ name: "Paperclip projects", url: "https://b.test/mcp", token: "tok-b", connectionId: "cb" }],
          runId: "run-b",
        }),
      ]);

      const content = JSON.parse(await fs.readFile(a.configPath, "utf8"));
      expect(content.mcpServers["Paperclip connections"]).toEqual({
        url: "https://a.test/mcp",
        headers: { Authorization: "Bearer tok-a" },
      });
      expect(content.mcpServers["Paperclip projects"]).toEqual({
        url: "https://b.test/mcp",
        headers: { Authorization: "Bearer tok-b" },
      });

      await a.cleanup();
      await b.cleanup();

      const exists = await fs.stat(a.configPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("cleanup leaves a same-named entry that a later run re-injected with a fresher token", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-test-"));

    try {
      const first = await writePaperclipAgyMcpConfig({
        homedir: tempDir,
        servers: [{ name: "Paperclip connections", url: "https://api.paperclip.test/mcp", token: "tok-old", connectionId: "c1" }],
        runId: "run-old",
      });
      const second = await writePaperclipAgyMcpConfig({
        homedir: tempDir,
        servers: [{ name: "Paperclip connections", url: "https://api.paperclip.test/mcp", token: "tok-new", connectionId: "c1" }],
        runId: "run-new",
      });

      // The first run's cleanup must not delete the second run's live entry.
      await first.cleanup();
      const afterFirstCleanup = JSON.parse(await fs.readFile(first.configPath, "utf8"));
      expect(afterFirstCleanup.mcpServers["Paperclip connections"]).toEqual({
        url: "https://api.paperclip.test/mcp",
        headers: { Authorization: "Bearer tok-new" },
      });

      await second.cleanup();
      const exists = await fs.stat(first.configPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
  it("never sweeps a user-owned entry that merely matches the injected shape", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-test-"));
    const configDir = path.join(tempDir, ".gemini", "config");
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "mcp_config.json");

    // The user configured this server themselves. It has exactly the shape
    // Paperclip injects (same name, url + bearer header), but Paperclip
    // never wrote it, so no ownership record exists for it.
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          "Paperclip connections": {
            url: "https://api.paperclip.test/mcp/connections",
            headers: { Authorization: "Bearer user-token" },
          },
        },
      }),
      "utf8",
    );

    try {
      const result = await writePaperclipAgyMcpConfig({
        homedir: tempDir,
        servers: [
          {
            name: "Paperclip connections",
            url: "https://api.paperclip.test/mcp/connections",
            token: "run-token",
            connectionId: "conn-1",
          },
        ],
      });

      expect(result.sweptStaleServerNames).toEqual([]);

      const content = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(content.mcpServers["Paperclip connections"]).toEqual({
        url: "https://api.paperclip.test/mcp/connections",
        headers: { Authorization: "Bearer user-token" },
      });
      expect(content.mcpServers["Paperclip connections-conn-1"]).toEqual({
        url: "https://api.paperclip.test/mcp/connections",
        headers: { Authorization: "Bearer run-token" },
      });

      // Cleanup removes only the run's own entry; the user's server stays.
      await result.cleanup();
      const after = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(after.mcpServers["Paperclip connections"]).toBeDefined();
      expect(after.mcpServers["Paperclip connections-conn-1"]).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("stageAgyMcpConfigForSync", () => {
  it("stages Paperclip MCP servers into a private directory with mcp_config.json", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-home-"));
    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "Paperclip connections",
        url: "https://api.paperclip.test/mcp/connections",
        token: "tok-123",
        connectionId: "conn-1",
      },
    ];

    const stagedDir = await stageAgyMcpConfigForSync({
      homedir: tempHome,
      servers,
      runId: "run-mcp-sync-1",
    });

    try {
      const stagedConfigPath = path.join(stagedDir, "mcp_config.json");
      const exists = await fs.stat(stagedConfigPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      const content = JSON.parse(await fs.readFile(stagedConfigPath, "utf8"));
      expect(content.mcpServers["Paperclip connections"]).toEqual({
        url: "https://api.paperclip.test/mcp/connections",
        headers: { Authorization: "Bearer tok-123" },
      });
    } finally {
      await Promise.all([
        fs.rm(tempHome, { recursive: true, force: true }).catch(() => undefined),
        fs.rm(stagedDir, { recursive: true, force: true }).catch(() => undefined),
      ]);
    }
  });

  it("merges existing host MCP servers when staging for sync", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-home-"));
    const configDir = path.join(tempHome, ".gemini", "config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          existing_tool: { url: "https://existing.tool/mcp" },
        },
      }),
    );

    const servers: AdapterRuntimeMcpServer[] = [
      {
        name: "paperclip_tool",
        url: "https://api.paperclip.test/mcp/tool",
        token: "",
        connectionId: "conn-2",
      },
    ];

    const stagedDir = await stageAgyMcpConfigForSync({
      homedir: tempHome,
      servers,
      runId: "run-mcp-sync-2",
    });

    try {
      const content = JSON.parse(await fs.readFile(path.join(stagedDir, "mcp_config.json"), "utf8"));
      expect(content.mcpServers.existing_tool).toEqual({ url: "https://existing.tool/mcp" });
      expect(content.mcpServers.paperclip_tool).toEqual({ url: "https://api.paperclip.test/mcp/tool" });
    } finally {
      await Promise.all([
        fs.rm(tempHome, { recursive: true, force: true }).catch(() => undefined),
        fs.rm(stagedDir, { recursive: true, force: true }).catch(() => undefined),
      ]);
    }
  });

  it("excludes servers other Paperclip runs injected into the host config", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-home-"));

    // Another run injected its server into the shared host config, so an
    // ownership record exists for it; the user also added a server by hand.
    await writePaperclipAgyMcpConfig({
      homedir: tempHome,
      servers: [
        {
          name: "Paperclip connections",
          url: "https://api.paperclip.test/mcp/connections",
          token: "other-run-token",
          connectionId: "conn-other",
        },
      ],
    });
    const hostConfigPath = path.join(tempHome, ".gemini", "config", "mcp_config.json");
    const hostConfig = JSON.parse(await fs.readFile(hostConfigPath, "utf8"));
    hostConfig.mcpServers.existing_tool = { url: "https://existing.tool/mcp" };
    await fs.writeFile(hostConfigPath, JSON.stringify(hostConfig, null, 2), "utf8");

    const stagedDir = await stageAgyMcpConfigForSync({
      homedir: tempHome,
      servers: [
        {
          name: "paperclip_tool",
          url: "https://api.paperclip.test/mcp/tool",
          token: "this-run-token",
          connectionId: "conn-2",
        },
      ],
      runId: "run-mcp-sync-3",
    });

    try {
      const content = JSON.parse(await fs.readFile(path.join(stagedDir, "mcp_config.json"), "utf8"));
      // The other run's credentials must not leak into this run's target.
      expect(content.mcpServers["Paperclip connections"]).toBeUndefined();
      expect(content.mcpServers.existing_tool).toEqual({ url: "https://existing.tool/mcp" });
      expect(content.mcpServers.paperclip_tool).toEqual({
        url: "https://api.paperclip.test/mcp/tool",
        headers: { Authorization: "Bearer this-run-token" },
      });
    } finally {
      await Promise.all([
        fs.rm(tempHome, { recursive: true, force: true }).catch(() => undefined),
        fs.rm(stagedDir, { recursive: true, force: true }).catch(() => undefined),
      ]);
    }
  });
});


describe("prepareAgyLocalRunMcpHome", () => {
  it("builds a private HOME with only the user's servers plus this run's", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-home-"));
    const cliHome = path.join(tempHome, ".gemini", "antigravity-cli");
    await fs.mkdir(cliHome, { recursive: true });
    const altCliHome = path.join(tempHome, ".gemini", "antigravity");
    await fs.mkdir(altCliHome, { recursive: true });

    // Another run's injected server (ownership recorded) plus a user server.
    await writePaperclipAgyMcpConfig({
      homedir: tempHome,
      servers: [
        {
          name: "Paperclip connections",
          url: "https://api.paperclip.test/mcp/connections",
          token: "other-run-token",
          connectionId: "conn-other",
        },
      ],
    });
    const hostConfigPath = path.join(tempHome, ".gemini", "config", "mcp_config.json");
    const hostConfig = JSON.parse(await fs.readFile(hostConfigPath, "utf8"));
    hostConfig.mcpServers.existing_tool = { url: "https://existing.tool/mcp" };
    await fs.writeFile(hostConfigPath, JSON.stringify(hostConfig, null, 2), "utf8");

    const prepared = await prepareAgyLocalRunMcpHome({
      homedir: tempHome,
      env: { HOME: tempHome },
      servers: [
        {
          name: "Paperclip projects",
          url: "https://api.paperclip.test/mcp/projects",
          token: "this-run-token",
          connectionId: "conn-2",
        },
      ],
      runId: "run-local-1",
    });

    try {
      expect(prepared.homeDir).not.toBe(tempHome);
      expect(prepared.injectedServerNames).toEqual(["Paperclip projects"]);

      const content = JSON.parse(await fs.readFile(prepared.configPath, "utf8"));
      expect(content.mcpServers["Paperclip connections"]).toBeUndefined();
      expect(content.mcpServers.existing_tool).toEqual({ url: "https://existing.tool/mcp" });
      expect(content.mcpServers["Paperclip projects"]).toEqual({
        url: "https://api.paperclip.test/mcp/projects",
        headers: { Authorization: "Bearer this-run-token" },
      });

      // Auth and conversation state stay shared with the host login: both
      // supported CLI homes are linked into the per-run HOME.
      const linkedCliHome = await fs.readlink(
        path.join(prepared.homeDir, ".gemini", "antigravity-cli"),
      );
      expect(path.resolve(prepared.homeDir, ".gemini", linkedCliHome)).toBe(cliHome);
      const linkedAltCliHome = await fs.readlink(
        path.join(prepared.homeDir, ".gemini", "antigravity"),
      );
      expect(path.resolve(prepared.homeDir, ".gemini", linkedAltCliHome)).toBe(altCliHome);

      // Preparing the per-run HOME never modifies the host config.
      const hostAfter = JSON.parse(await fs.readFile(hostConfigPath, "utf8"));
      expect(hostAfter.mcpServers["Paperclip projects"]).toBeUndefined();
      expect(hostAfter.mcpServers["Paperclip connections"]).toBeDefined();
    } finally {
      await prepared.cleanup();
    }

    const exists = await fs.stat(prepared.homeDir).then(() => true).catch(() => false);
    expect(exists).toBe(false);
    await fs.rm(tempHome, { recursive: true, force: true }).catch(() => undefined);
  });
});

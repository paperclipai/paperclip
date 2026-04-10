import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mergeClaudeMcpServersJson,
  mergeCodexConfigToml,
  resolveConfiguredExternalMcpServers,
  syncConfiguredExternalMcpServers,
} from "../external-mcp-config.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("external MCP config", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("resolves the dedicated Rube env contract", () => {
    expect(resolveConfiguredExternalMcpServers({
      PAPERCLIP_RUBE_MCP_URL: "https://rube.example/mcp",
      PAPERCLIP_RUBE_MCP_HEADERS_JSON: JSON.stringify({
        Authorization: "Bearer test-token",
        "X-Workspace": "paperclip",
      }),
    })).toEqual([
      {
        name: "rube",
        type: "http",
        url: "https://rube.example/mcp",
        headers: {
          Authorization: "Bearer test-token",
          "X-Workspace": "paperclip",
        },
      },
    ]);
  });

  it("accepts additional generic external MCP servers and sorts them by name", () => {
    expect(resolveConfiguredExternalMcpServers({
      PAPERCLIP_RUBE_MCP_URL: "https://rube.example/mcp",
      PAPERCLIP_EXTERNAL_MCP_SERVERS_JSON: JSON.stringify([
        { name: "zeta", type: "http", url: "https://zeta.example/mcp" },
        { name: "alpha", type: "http", url: "https://alpha.example/mcp" },
      ]),
    }).map((server) => server.name)).toEqual(["alpha", "rube", "zeta"]);
  });

  it("merges Claude MCP server JSON without removing existing servers", () => {
    const merged = mergeClaudeMcpServersJson(
      JSON.stringify({
        mcpServers: {
          playwright: {
            command: "npx",
            args: ["@playwright/mcp@latest"],
          },
        },
      }),
      [
        {
          name: "rube",
          type: "http",
          url: "https://rube.example/mcp",
          headers: { Authorization: "Bearer test-token" },
        },
      ],
    );

    expect(JSON.parse(merged)).toEqual({
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["@playwright/mcp@latest"],
        },
        rube: {
          type: "http",
          url: "https://rube.example/mcp",
          headers: { Authorization: "Bearer test-token" },
        },
      },
    });
  });

  it("merges Codex TOML blocks idempotently", () => {
    const merged = mergeCodexConfigToml(
      [
        '[mcp_servers.playwright]',
        'command = "npx"',
        'args = ["@playwright/mcp@latest"]',
        "",
      ].join("\n"),
      [
        {
          name: "rube",
          type: "http",
          url: "https://rube.example/mcp",
        },
      ],
    );

    expect(merged).toContain('[mcp_servers.playwright]');
    expect(merged).toContain('[mcp_servers.rube]');
    expect(merged).toContain('url = "https://rube.example/mcp"');
    expect(mergeCodexConfigToml(merged, [
      {
        name: "rube",
        type: "http",
        url: "https://rube.example/mcp",
      },
    ])).toBe(merged);
  });

  it("renders Codex header tables for authenticated MCP servers", () => {
    const merged = mergeCodexConfigToml("", [
      {
        name: "rube",
        type: "http",
        url: "https://backend.composio.dev/tool_router/trs_test/mcp",
        headers: {
          "x-api-key": "ak_test",
          Authorization: "Bearer test",
        },
      },
    ]);

    expect(merged).toContain('[mcp_servers.rube]');
    expect(merged).toContain('url = "https://backend.composio.dev/tool_router/trs_test/mcp"');
    expect(merged).toContain('[mcp_servers.rube.headers]');
    expect(merged).toContain('"Authorization" = "Bearer test"');
    expect(merged).toContain('"x-api-key" = "ak_test"');
  });

  it("writes shared Claude and Codex config files during startup sync", async () => {
    const root = await makeTempDir("paperclip-external-mcp-");
    cleanupDirs.add(root);
    const codexHome = path.join(root, ".codex");
    const claudeHome = path.join(root, ".claude");

    await fs.mkdir(codexHome, { recursive: true });
    await fs.mkdir(claudeHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, "config.toml"), '[mcp_servers.playwright]\ncommand = "npx"\n', "utf8");
    await fs.writeFile(
      path.join(claudeHome, "mcp-servers.json"),
      `${JSON.stringify({ mcpServers: { betterstack: { type: "http", url: "https://betterstack.example/mcp" } } }, null, 2)}\n`,
      "utf8",
    );

    const env = {
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      PAPERCLIP_RUBE_MCP_URL: "https://rube.example/mcp",
    };

    const first = await syncConfiguredExternalMcpServers(env);
    expect(first).toEqual({
      configured: true,
      syncedServers: ["rube"],
      updatedCodexConfig: true,
      updatedClaudeConfig: true,
    });

    const codexConfig = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
    const claudeConfig = await fs.readFile(path.join(claudeHome, "mcp-servers.json"), "utf8");
    expect(codexConfig).toContain('[mcp_servers.playwright]');
    expect(codexConfig).toContain('[mcp_servers.rube]');
    expect(JSON.parse(claudeConfig)).toEqual({
      mcpServers: {
        betterstack: { type: "http", url: "https://betterstack.example/mcp" },
        rube: { type: "http", url: "https://rube.example/mcp" },
      },
    });

    const second = await syncConfiguredExternalMcpServers(env);
    expect(second).toEqual({
      configured: true,
      syncedServers: ["rube"],
      updatedCodexConfig: false,
      updatedClaudeConfig: false,
    });
  });
});

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
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer test-token",
          "X-Workspace": "paperclip",
        },
      },
    ]);
  });

  it("adds the Composio MCP Accept header when Rube headers omit it", () => {
    expect(resolveConfiguredExternalMcpServers({
      PAPERCLIP_RUBE_MCP_URL: "https://rube.example/mcp",
      PAPERCLIP_RUBE_MCP_HEADERS_JSON: JSON.stringify({
        "x-api-key": "ak_test",
      }),
    })).toEqual([
      {
        name: "rube",
        type: "http",
        url: "https://rube.example/mcp",
        headers: {
          Accept: "application/json, text/event-stream",
          "x-api-key": "ak_test",
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

  it("does not accumulate duplicate headers on repeated syncs", () => {
    const server = {
      name: "rube",
      type: "http" as const,
      url: "https://backend.example/mcp",
      headers: { Authorization: "Bearer test", "x-api-key": "ak_test" },
    };

    // Start with an empty config and merge 5 times — result must be identical each time
    const results: string[] = [];
    let current: string | undefined;
    for (let i = 0; i < 5; i++) {
      current = mergeCodexConfigToml(current, [server]);
      results.push(current);
    }

    // Each merge must produce the same output as the previous one (idempotent)
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[i - 1]);
    }

    const final_1 = results[results.length - 1];
    // Exactly one parent block and one http_headers line — no duplicates
    expect(final_1.match(/\[mcp_servers\.rube\](?!\.)/g)).toHaveLength(1);
    expect((final_1.match(/http_headers\s*=/g) ?? [])).toHaveLength(1);
    // Headers content appears exactly once
    expect((final_1.match(/"Authorization" = "Bearer test"/g) ?? [])).toHaveLength(1);
    expect((final_1.match(/"x-api-key" = "ak_test"/g) ?? [])).toHaveLength(1);
  });

  it("renders Codex header tables for authenticated MCP servers", () => {
    const merged = mergeCodexConfigToml("", [
      {
        name: "rube",
        type: "http",
        url: "https://backend.composio.dev/tool_router/trs_test/mcp",
        headers: {
          Accept: "application/json, text/event-stream",
          "x-api-key": "ak_test",
          Authorization: "Bearer test",
        },
      },
    ]);

    expect(merged).toContain('[mcp_servers.rube]');
    expect(merged).toContain('url = "https://backend.composio.dev/tool_router/trs_test/mcp"');
    expect(merged).toContain('http_headers = { "Accept" = "application/json, text/event-stream", "Authorization" = "Bearer test", "x-api-key" = "ak_test" }');
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
    expect(codexConfig).toContain('http_headers = { "Accept" = "application/json, text/event-stream" }');
    expect(JSON.parse(claudeConfig)).toEqual({
      mcpServers: {
        betterstack: { type: "http", url: "https://betterstack.example/mcp" },
        rube: {
          type: "http",
          url: "https://rube.example/mcp",
          headers: { Accept: "application/json, text/event-stream" },
        },
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

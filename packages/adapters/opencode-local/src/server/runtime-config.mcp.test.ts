import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterRuntimeMcpAccess } from "@paperclipai/adapter-utils";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function makeConfigHome(initialConfig?: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-mcp-test-"));
  cleanupPaths.add(root);
  const configDir = path.join(root, "opencode");
  await fs.mkdir(configDir, { recursive: true });
  if (initialConfig) {
    await fs.writeFile(
      path.join(configDir, "opencode.json"),
      `${JSON.stringify(initialConfig, null, 2)}\n`,
      "utf8",
    );
  }
  return root;
}

/** Mirrors how heartbeat.ts builds ctx.runtimeMcp for an adapter execution. */
function fakeRuntimeMcp(
  servers: readonly { name: string; url: string; token: string; connectionId: string }[],
): AdapterRuntimeMcpAccess {
  return { getServers: () => servers.map((server) => ({ ...server })) };
}

async function readRuntimeConfig(prepared: { env: Record<string, string> }) {
  cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
  return JSON.parse(
    await fs.readFile(
      path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
      "utf8",
    ),
  ) as { mcp?: Record<string, { type?: string; url?: string; enabled?: boolean; headers?: Record<string, string> }> };
}

describe("prepareOpenCodeRuntimeConfig runtime MCP delivery", () => {
  it("writes a ctx.runtimeMcp server into opencode.json as a remote MCP server", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const runtimeMcp = fakeRuntimeMcp([
      {
        name: "Notion",
        url: "http://localhost:3100/mcp/gateways/gw_notion_abc123",
        token: "run-scoped-gateway-token",
        connectionId: "conn-notion",
      },
    ]);

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      runtimeMcpServers: runtimeMcp.getServers(),
    });

    const runtimeConfig = await readRuntimeConfig(prepared);
    expect(runtimeConfig.mcp?.Notion).toEqual({
      type: "remote",
      url: "http://localhost:3100/mcp/gateways/gw_notion_abc123",
      enabled: true,
      oauth: false,
      headers: { Authorization: "Bearer run-scoped-gateway-token" },
    });
    expect(prepared.notes).toContain(
      "Registered 1 Paperclip-managed MCP server(s) with OpenCode: Notion.",
    );
    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });

  it("keeps every runtime server and does not overwrite a user's own mcp entry", async () => {
    const configHome = await makeConfigHome({
      mcp: { "user-server": { type: "local", command: ["my-mcp"] } },
    });
    const runtimeMcp = fakeRuntimeMcp([
      {
        name: "Paperclip connections",
        url: "http://localhost:3100/mcp/runtime-tools",
        token: "connections-token",
        connectionId: "paperclip-runtime-tools",
      },
      {
        name: "Notion",
        url: "http://localhost:3100/mcp/gateways/gw_notion_abc123",
        token: "notion-token",
        connectionId: "conn-notion",
      },
    ]);

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      runtimeMcpServers: runtimeMcp.getServers(),
    });

    const runtimeConfig = await readRuntimeConfig(prepared);
    expect(runtimeConfig.mcp?.["user-server"]).toEqual({ type: "local", command: ["my-mcp"] });
    expect(runtimeConfig.mcp?.["Paperclip connections"]?.url).toBe(
      "http://localhost:3100/mcp/runtime-tools",
    );
    expect(runtimeConfig.mcp?.Notion?.type).toBe("remote");
    await prepared.cleanup();
  });

  it("disambiguates two runtime servers that share a display name", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      runtimeMcpServers: fakeRuntimeMcp([
        { name: "Notion", url: "http://a/mcp", token: "a", connectionId: "conn-aaaaaaaa" },
        { name: "Notion", url: "http://b/mcp", token: "b", connectionId: "conn-bbbbbbbb" },
      ]).getServers(),
    });

    const runtimeConfig = await readRuntimeConfig(prepared);
    const urls = Object.values(runtimeConfig.mcp ?? {}).map((entry) => entry.url);
    expect(urls).toEqual(["http://a/mcp", "http://b/mcp"]);
    await prepared.cleanup();
  });

  it("sets no mcp key when the run has no runtime MCP servers", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      runtimeMcpServers: fakeRuntimeMcp([]).getServers(),
    });

    const runtimeConfig = await readRuntimeConfig(prepared);
    expect(runtimeConfig.mcp).toBeUndefined();
    expect(prepared.notes.some((note) => note.includes("MCP server"))).toBe(false);
    await prepared.cleanup();
  });
});
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCursorMcpConfigDocument,
  parseResolvedMcpServers,
  prepareCursorAgentHomeMcpConfig,
  prepareCursorMcpConfigAsset,
  removeCursorAgentHomeMcpConfig,
  resolveCursorAgentHomeDir,
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
      },
    });
    expect(Object.keys(parsed).sort()).toEqual(["files", "linear"]);
    expect(parsed.linear).toMatchObject({ transport: "http", url: "https://mcp.linear.app/mcp" });
    expect(parsed.files).toMatchObject({ transport: "stdio", command: "npx" });
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

describe("buildCursorMcpConfigDocument", () => {
  it("emits Cursor's ~/.cursor/mcp.json shape without a type discriminator", () => {
    const doc = buildCursorMcpConfigDocument(
      parseResolvedMcpServers({
        linear: {
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer tok" },
        },
        events: { transport: "sse", url: "https://api.example.com/sse", headers: {} },
        files: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "files-mcp"],
          env: { ROOT: "/tmp" },
        },
      }),
    );
    expect(doc).toEqual({
      mcpServers: {
        linear: {
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer tok" },
        },
        events: { url: "https://api.example.com/sse" },
        files: {
          command: "npx",
          args: ["-y", "files-mcp"],
          env: { ROOT: "/tmp" },
        },
      },
    });
  });

  it("omits empty args/env/headers", () => {
    const doc = buildCursorMcpConfigDocument(
      parseResolvedMcpServers({
        bare: { transport: "stdio", command: "run-mcp" },
      }),
    );
    expect(doc.mcpServers.bare).toEqual({ command: "run-mcp" });
  });

  it("returns an empty mcpServers record for no servers", () => {
    expect(buildCursorMcpConfigDocument({})).toEqual({ mcpServers: {} });
  });
});

describe("removeCursorAgentHomeMcpConfig", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const makeEnv = async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-home-test-"));
    cleanupDirs.push(home);
    return { PAPERCLIP_HOME: home } as NodeJS.ProcessEnv;
  };

  it("removes a stale per-agent mcp.json and reports removal", async () => {
    const env = await makeEnv();
    await prepareCursorAgentHomeMcpConfig({
      agentId: "agent-1",
      servers: parseResolvedMcpServers({
        files: { transport: "stdio", command: "npx", env: { API_KEY: "stdio-secret" } },
      }),
      env,
    });
    const mcpConfigPath = path.join(resolveCursorAgentHomeDir("agent-1", env), ".cursor", "mcp.json");
    expect(await fs.readFile(mcpConfigPath, "utf-8")).toContain("stdio-secret");

    expect(await removeCursorAgentHomeMcpConfig({ agentId: "agent-1", env })).toBe(true);
    await expect(fs.access(mcpConfigPath)).rejects.toThrow();
  });

  it("is a no-op when there is no per-agent mcp.json", async () => {
    const env = await makeEnv();
    expect(await removeCursorAgentHomeMcpConfig({ agentId: "agent-1", env })).toBe(false);
  });
});

describe("prepareCursorMcpConfigAsset", () => {
  it("writes mcp.json into a temp asset dir and cleans up", async () => {
    const prepared = await prepareCursorMcpConfigAsset(
      parseResolvedMcpServers({
        linear: {
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer secret-token" },
        },
      }),
    );
    try {
      expect(prepared.fileName).toBe("mcp.json");
      const raw = await fs.readFile(path.join(prepared.localDir, prepared.fileName), "utf-8");
      const parsed = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
      expect(parsed.mcpServers.linear).toEqual({
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer secret-token" },
      });
    } finally {
      await prepared.cleanup();
    }
    await expect(fs.access(prepared.localDir)).rejects.toThrow();
  });
});

import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildClaudeMcpAllowedToolPatterns,
  buildClaudeMcpConfigDocument,
  parseResolvedMcpServers,
  prepareClaudeMcpConfigFile,
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

describe("buildClaudeMcpConfigDocument", () => {
  it("emits Claude Code's .mcp.json shape", () => {
    const doc = buildClaudeMcpConfigDocument(
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
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer tok" },
        },
        events: { type: "sse", url: "https://api.example.com/sse" },
        files: {
          type: "stdio",
          command: "npx",
          args: ["-y", "files-mcp"],
          env: { ROOT: "/tmp" },
        },
      },
    });
  });

  it("omits empty args/env/headers", () => {
    const doc = buildClaudeMcpConfigDocument(
      parseResolvedMcpServers({
        bare: { transport: "stdio", command: "run-mcp" },
      }),
    );
    expect(doc.mcpServers.bare).toEqual({ type: "stdio", command: "run-mcp" });
  });
});

describe("buildClaudeMcpAllowedToolPatterns", () => {
  it("uses whole-server wildcards by default and explicit tools when listed", () => {
    const patterns = buildClaudeMcpAllowedToolPatterns(
      parseResolvedMcpServers({
        linear: {
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          allowedTools: ["list_issues", "create_issue"],
        },
        files: { transport: "stdio", command: "npx" },
      }),
    );
    expect(patterns.sort()).toEqual([
      "mcp__files__*",
      "mcp__linear__create_issue",
      "mcp__linear__list_issues",
    ]);
  });

  it("returns empty for no servers", () => {
    expect(buildClaudeMcpAllowedToolPatterns({})).toEqual([]);
  });
});

describe("prepareClaudeMcpConfigFile", () => {
  it("writes the config document and cleans up", async () => {
    const prepared = await prepareClaudeMcpConfigFile({
      runId: "run-1",
      servers: parseResolvedMcpServers({
        linear: {
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer secret-token" },
        },
      }),
    });
    try {
      const raw = await fs.readFile(prepared.localFilePath, "utf-8");
      const parsed = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
      expect(parsed.mcpServers.linear).toMatchObject({
        type: "http",
        headers: { Authorization: "Bearer secret-token" },
      });
      expect(prepared.fileName).toBe("mcp-run-1.json");
    } finally {
      await prepared.cleanup();
    }
    await expect(fs.access(prepared.localFilePath)).rejects.toThrow();
  });
});

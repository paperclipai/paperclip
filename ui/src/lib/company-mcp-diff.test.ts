import { describe, expect, it } from "vitest";
import type { McpServerConfig, McpServersConfig } from "@paperclipai/shared";
import { diffMcpServerRecords, toCatalogServerWrite } from "./company-mcp-diff";

const github: McpServerConfig = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
};

const linear: McpServerConfig = {
  transport: "http",
  url: "https://mcp.linear.app/mcp",
};

const record: McpServersConfig = { github, linear };

describe("diffMcpServerRecords", () => {
  it("returns an empty diff when entries pass through by reference", () => {
    expect(diffMcpServerRecords(record, { github, linear })).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });

  it("detects added servers", () => {
    const notion: McpServerConfig = { transport: "sse", url: "https://mcp.notion.com/sse" };
    expect(diffMcpServerRecords(record, { github, linear, notion })).toEqual({
      added: [{ name: "notion", config: notion }],
      changed: [],
      removed: [],
    });
  });

  it("detects removed servers", () => {
    expect(diffMcpServerRecords(record, { github })).toEqual({
      added: [],
      changed: [],
      removed: ["linear"],
    });
  });

  it("flags enabled-only toggles so callers can PATCH { enabled } without config", () => {
    const toggled: McpServerConfig = { ...linear, enabled: false };
    expect(diffMcpServerRecords(record, { github, linear: toggled })).toEqual({
      added: [],
      changed: [{ name: "linear", config: toggled, enabledOnly: true }],
      removed: [],
    });
  });

  it("treats enabled toggles as enabled-only even when GET-only fields ride along", () => {
    const sanitized = {
      transport: "http",
      url: "https://mcp.sentry.dev/mcp",
      auth: { type: "oauth", secretId: null, connected: false },
    } as unknown as McpServerConfig;
    const toggled: McpServerConfig = { ...sanitized, enabled: false };
    expect(diffMcpServerRecords({ sentry: sanitized }, { sentry: toggled })).toEqual({
      added: [],
      changed: [{ name: "sentry", config: toggled, enabledOnly: true }],
      removed: [],
    });
  });

  it("marks config edits as full changes", () => {
    const moved: McpServerConfig = { transport: "http", url: "https://mcp.linear.app/v2/mcp" };
    expect(diffMcpServerRecords(record, { github, linear: moved })).toEqual({
      added: [],
      changed: [{ name: "linear", config: moved, enabledOnly: false }],
      removed: [],
    });
  });

  it("ignores key order and undefined values when comparing rebuilt configs", () => {
    const rebuilt: McpServerConfig = {
      args: ["-y", "@modelcontextprotocol/server-github"],
      command: "npx",
      transport: "stdio",
    };
    expect(diffMcpServerRecords({ github }, { github: rebuilt })).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });

  it("reports a rename as an add plus a remove", () => {
    expect(diffMcpServerRecords({ github }, { gh: github })).toEqual({
      added: [{ name: "gh", config: github }],
      changed: [],
      removed: ["github"],
    });
  });
});

describe("toCatalogServerWrite", () => {
  it("moves enabled out of the config and into the row flag", () => {
    const result = toCatalogServerWrite({ ...github, enabled: false });
    expect(result.enabled).toBe(false);
    expect(result.config).toEqual(github);
  });

  it("defaults enabled to true when unset", () => {
    expect(toCatalogServerWrite(github).enabled).toBe(true);
  });

  it("strips the sanitized connected marker from OAuth auth", () => {
    const sanitized = {
      transport: "sse",
      url: "https://mcp.notion.com/sse",
      auth: { type: "oauth", secretId: null, connected: false },
    } as unknown as McpServerConfig;
    expect(toCatalogServerWrite(sanitized).config).toEqual({
      transport: "sse",
      url: "https://mcp.notion.com/sse",
      auth: { type: "oauth", secretId: null },
    });
  });

  it("preserves a connected OAuth secretId and version", () => {
    const connected = {
      transport: "http",
      url: "https://mcp.sentry.dev/mcp",
      auth: {
        type: "oauth",
        secretId: "00000000-0000-4000-8000-000000000003",
        version: "latest",
        connected: true,
      },
    } as unknown as McpServerConfig;
    expect(toCatalogServerWrite(connected).config).toEqual({
      transport: "http",
      url: "https://mcp.sentry.dev/mcp",
      auth: {
        type: "oauth",
        secretId: "00000000-0000-4000-8000-000000000003",
        version: "latest",
      },
    });
  });
});

import { describe, expect, it } from "vitest";
import { buildOpenCodeMcpConfig, parseResolvedMcpServers } from "./mcp-config.js";

describe("parseResolvedMcpServers", () => {
  it("accepts only fully-resolved entries with plain string values", () => {
    const parsed = parseResolvedMcpServers({
      good: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-mcp", 42],
        env: { API_KEY: "plain", REF: { secretRef: "unresolved" } },
        timeoutMs: 5000,
      },
      remote: {
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer tok" },
      },
      missingCommand: { transport: "stdio", command: "   " },
      missingUrl: { transport: "sse", url: "" },
      badTransport: { transport: "websocket", url: "https://x" },
      notAnObject: "nope",
    });

    expect(Object.keys(parsed).sort()).toEqual(["good", "remote"]);
    expect(parsed.good).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "some-mcp"],
      env: { API_KEY: "plain" },
      timeoutMs: 5000,
    });
    expect(parsed.good.env).not.toHaveProperty("REF");
    expect(parsed.remote).toMatchObject({
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("returns an empty record for non-object input", () => {
    expect(parseResolvedMcpServers(null)).toEqual({});
    expect(parseResolvedMcpServers("x")).toEqual({});
    expect(parseResolvedMcpServers([{ transport: "stdio", command: "x" }])).toEqual({});
  });
});

describe("buildOpenCodeMcpConfig", () => {
  it("maps stdio servers to local entries with a [program, ...args] command array", () => {
    const mcp = buildOpenCodeMcpConfig({
      files: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { API_KEY: "secret-value" },
        timeoutMs: 5000,
      },
    });

    expect(mcp).toEqual({
      files: {
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        environment: { API_KEY: "secret-value" },
        enabled: true,
        timeout: 5000,
      },
    });
  });

  it("omits environment and timeout when empty and unset", () => {
    const mcp = buildOpenCodeMcpConfig({
      bare: { transport: "stdio", command: "mcp-server", args: [], env: {} },
    });

    expect(mcp).toEqual({
      bare: {
        type: "local",
        command: ["mcp-server"],
        enabled: true,
      },
    });
  });

  it("maps http and sse servers to remote entries with oauth disabled", () => {
    const mcp = buildOpenCodeMcpConfig({
      httpish: {
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer resolved-token" },
      },
      ssevariant: {
        transport: "sse",
        url: "https://sse.example.com/mcp",
        headers: {},
      },
    });

    expect(mcp).toEqual({
      httpish: {
        type: "remote",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer resolved-token" },
        oauth: false,
        enabled: true,
      },
      ssevariant: {
        type: "remote",
        url: "https://sse.example.com/mcp",
        oauth: false,
        enabled: true,
      },
    });
  });
});

import { describe, expect, it } from "vitest";
import { mcpServersSchema, createAgentSchema } from "./agent.js";

describe("mcpServersSchema", () => {
  it("accepts a stdio server with secret_ref env", () => {
    const result = mcpServersSchema.safeParse({
      linear: {
        type: "stdio",
        command: "mcp-linear",
        args: [],
        env: {
          LINEAR_API_KEY: {
            type: "secret_ref",
            secretId: "33333333-3333-4333-8333-333333333333",
            version: "latest",
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a stdio server with plain string env (legacy compat)", () => {
    const result = mcpServersSchema.safeParse({
      linear: { type: "stdio", command: "mcp-linear", args: [], env: { FOO: "bar" } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an http server with header secret_ref", () => {
    const result = mcpServersSchema.safeParse({
      linear: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: {
          Authorization: {
            type: "secret_ref",
            secretId: "33333333-3333-4333-8333-333333333333",
            version: "latest",
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an sse server with url and no headers", () => {
    const result = mcpServersSchema.safeParse({
      remote: { type: "sse", url: "https://example.com/sse" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a stdio server missing command", () => {
    const result = mcpServersSchema.safeParse({
      linear: { type: "stdio", args: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an http server missing url", () => {
    const result = mcpServersSchema.safeParse({
      linear: { type: "http", headers: {} },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown transport type", () => {
    const result = mcpServersSchema.safeParse({
      linear: { type: "websocket", url: "ws://x" },
    });
    expect(result.success).toBe(false);
  });

  it("allows an empty mcpServers object", () => {
    const result = mcpServersSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe("createAgentSchema with mcpServers", () => {
  it("accepts an adapterConfig containing valid mcpServers", () => {
    const result = createAgentSchema.safeParse({
      name: "lead",
      adapterType: "claude_local",
      adapterConfig: {
        mcpServers: {
          linear: {
            type: "stdio",
            command: "mcp-linear",
            args: [],
            env: {
              LINEAR_API_KEY: {
                type: "secret_ref",
                secretId: "33333333-3333-4333-8333-333333333333",
                version: "latest",
              },
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an adapterConfig with malformed mcpServers entry", () => {
    const result = createAgentSchema.safeParse({
      name: "lead",
      adapterType: "claude_local",
      adapterConfig: {
        mcpServers: {
          linear: { type: "stdio" }, // missing command
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths.some((p) => p.startsWith("adapterConfig.mcpServers"))).toBe(true);
    }
  });
});

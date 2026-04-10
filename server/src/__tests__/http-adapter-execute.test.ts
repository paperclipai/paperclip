import { afterEach, describe, expect, it, vi } from "vitest";
import { execute, isComposioMcpUrl } from "../adapters/http/execute.js";

type FetchCall = {
  url: string;
  init: RequestInit;
};

function buildContext(config: Record<string, unknown>) {
  return {
    runId: "run_123",
    agent: {
      id: "agent_123",
    },
    context: {
      source: "unit-test",
    },
    config,
  } as any;
}

describe("http adapter execute", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches Composio MCP URL patterns", () => {
    expect(isComposioMcpUrl("https://api.composio.dev/tool_router/session123/mcp")).toBe(true);
    expect(isComposioMcpUrl("https://api.composio.dev/tool_router/session123/mcp/")).toBe(true);
    expect(isComposioMcpUrl("https://backend.example.com/v3/mcp/cfg_456/mcp")).toBe(true);
    expect(isComposioMcpUrl("https://backend.example.com/v3/mcp/cfg_456/mcp/")).toBe(true);
    expect(isComposioMcpUrl("https://api.composio.dev/tool_router/session123/not-mcp")).toBe(false);
    expect(isComposioMcpUrl("https://backend.example.com/v3/mcp/cfg_456/not-mcp")).toBe(false);
    expect(isComposioMcpUrl("https://backend.example.com/v3/mcp/cfg_456")).toBe(false);
    expect(isComposioMcpUrl("https://backend.example.com/v1/other")).toBe(false);
  });

  it("injects Accept header for Composio MCP calls when missing", async () => {
    const calls: FetchCall[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({
        url: String(input),
        init: init ?? {},
      });
      return new Response("ok", { status: 200 });
    });

    await execute(
      buildContext({
        url: "https://api.composio.dev/tool_router/session123/mcp",
        method: "POST",
        headers: {
          "x-api-key": "secret",
        },
        payloadTemplate: {},
      }),
    );

    expect(calls).toHaveLength(1);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json, text/event-stream");
  });

  it("does not double-prefix user_id when already normalized", async () => {
    const calls: FetchCall[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({
        url: String(input),
        init: init ?? {},
      });
      return new Response("ok", { status: 200 });
    });

    await execute(
      buildContext({
        url: "https://api.example.com/v3/mcp/cfg_456/mcp",
        method: "POST",
        headers: {},
        payloadTemplate: {
          user_id: "user_abc123",
        },
      }),
    );

    const body = JSON.parse(String(calls[0]?.init.body ?? "{}")) as Record<string, unknown>;
    expect(body.user_id).toBe("user_abc123");
  });

  it("includes status, cf-ray, timestamp, and body in non-2xx error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("composio upstream failed", {
        status: 502,
        headers: {
          "cf-ray": "abc123",
        },
      }),
    );

    await expect(
      execute(
        buildContext({
          url: "https://api.composio.dev/tool_router/session123/mcp",
          method: "POST",
          headers: {},
          payloadTemplate: {},
        }),
      ),
    ).rejects.toThrow(
      /HTTP invoke failed with status 502, cf-ray: abc123, timestamp: .*Z, body: composio upstream failed/,
    );
  });
});

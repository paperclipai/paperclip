import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext, AdapterRuntimeToolAccess } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

const runtimeTools: AdapterRuntimeToolAccess = {
  version: 1,
  guidance: "use tools",
  mcpEndpoint: "http://127.0.0.1:3100/mcp",
  rest: {
    connectionsSearch: "http://127.0.0.1:3100/api/connections/search",
    connectionRequest: "http://127.0.0.1:3100/api/connections/request",
  },
  bearerToken: "tok",
  expiresAt: "2030-01-01T00:00:00.000Z",
  tools: ["connections_search", "connection_request"],
} as AdapterRuntimeToolAccess;

describe("agy_local execute", () => {
  it("delivers runtime tools through the environment", async () => {
    let metaEnv: Record<string, string> | undefined;
    const ctx = {
      runId: "run-1",
      agent: { id: "a1", companyId: "c1", name: "Harry", adapterType: "agy_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: process.execPath },
      context: {},
      runtimeTools,
      onLog: async () => {},
      onMeta: async (meta: { env?: Record<string, string> }) => {
        metaEnv = meta.env;
        throw new Error("stop before spawn");
      },
    } as unknown as AdapterExecutionContext;
    await expect(execute(ctx)).rejects.toThrow("stop before spawn");
    expect(metaEnv?.PAPERCLIP_RUNTIME_TOOLS_MCP_URL).toBe("http://127.0.0.1:3100/mcp");
  });
});

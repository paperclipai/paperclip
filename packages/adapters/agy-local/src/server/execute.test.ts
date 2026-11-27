import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

async function captureMeta(config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  let captured: { env?: Record<string, string>; prompt?: string } = {};
  const ctx = {
    runId: "run-1",
    agent: { id: "a1", companyId: "c1", name: "Harry", adapterType: "agy_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: process.execPath, ...config },
    context: {},
    onLog: async () => {},
    onMeta: async (meta: { env?: Record<string, string>; prompt?: string }) => {
      captured = meta;
      throw new Error("stop before spawn");
    },
    ...extra,
  } as unknown as AdapterExecutionContext;
  await expect(execute(ctx)).rejects.toThrow("stop before spawn");
  return captured;
}

describe("agy_local execute", () => {
  it("delivers runtime tools through the environment", async () => {
    const meta = await captureMeta({}, { runtimeTools });
    expect(meta.env?.PAPERCLIP_RUNTIME_TOOLS_MCP_URL).toBe("http://127.0.0.1:3100/mcp");
  });

  it("keeps Paperclip's run identity when configured env sets the same keys", async () => {
    const meta = await captureMeta({
      env: { PAPERCLIP_RUN_ID: "stale-run", PAPERCLIP_AGENT_ID: "stale-agent", MY_FLAG: "on" },
    });
    expect(meta.env?.PAPERCLIP_RUN_ID).toBe("run-1");
    expect(meta.env?.PAPERCLIP_AGENT_ID).toBe("a1");
    expect(meta.env?.MY_FLAG).toBe("on");
  });

  it("tells the agent where the instructions file lives", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agy-instr-"));
    try {
      const file = path.join(dir, "AGENTS.md");
      await writeFile(file, "Follow ./style.md");
      const meta = await captureMeta({ instructionsFilePath: file });
      expect(meta.prompt).toContain("Follow ./style.md");
      expect(meta.prompt).toContain(`Resolve any relative file references from ${dir}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

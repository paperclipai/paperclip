import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import plugin, { resetOpenCrabCallerForTests, setOpenCrabCallerForTests } from "./worker.js";
import { PLUGIN_ID, TOOL_NAMES } from "./constants.js";

function createContext(config: Record<string, unknown> = {}) {
  const handlers = new Map<string, (params: unknown, runCtx: { agentId: string; runId: string; companyId: string; projectId: string }) => Promise<ToolResult>>();
  const ctx = {
    manifest,
    config: {
      get: vi.fn(async () => config),
    },
    secrets: {
      resolve: vi.fn(async (ref: string) => `https://opencrab.sh/api/mcp/${ref}`),
    },
    http: {
      fetch: vi.fn(),
    },
    tools: {
      register: vi.fn((name: string, _declaration: unknown, fn: (params: unknown, runCtx: { agentId: string; runId: string; companyId: string; projectId: string }) => Promise<ToolResult>) => {
        handlers.set(name, fn);
      }),
    },
  } as unknown as PluginContext;

  return { ctx, handlers };
}

describe("OpenCrab ontology plugin", () => {
  beforeEach(() => {
    resetOpenCrabCallerForTests();
  });

  it("declares read-only OpenCrab tools in the manifest", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.capabilities).toContain("agent.tools.register");
    expect(manifest.capabilities).toContain("http.outbound");
    expect(manifest.capabilities).toContain("secrets.read-ref");
    expect(manifest.tools?.map((tool) => tool.name)).toEqual([
      TOOL_NAMES.status,
      TOOL_NAMES.query,
      TOOL_NAMES.searchDocuments,
      TOOL_NAMES.searchNodes,
      TOOL_NAMES.getNodeContext,
      TOOL_NAMES.searchPacks,
    ]);
  });

  it("registers all manifest tools during setup", async () => {
    const { ctx } = createContext({ endpoint: "https://opencrab.sh/api/mcp/test-secret" });

    await plugin.definition.setup(ctx);

    expect(ctx.tools.register).toHaveBeenCalledTimes(6);
  });

  it("routes query calls to OpenCrab with bounded top_k and workspace scope", async () => {
    const calls: unknown[] = [];
    setOpenCrabCallerForTests(async (_ctx, request) => {
      calls.push(request);
      return { answer: "ok" };
    });
    const { ctx, handlers } = createContext({
      endpoint: "https://opencrab.sh/api/mcp/test-secret",
      workspaceId: "workspace-default",
      defaultLimit: 5,
      maxLimit: 20,
    });
    await plugin.definition.setup(ctx);

    const result = await handlers.get(TOOL_NAMES.query)?.({ query: "FMG", topK: 99 }, {
      agentId: "agent-1",
      runId: "run-1",
      companyId: "company-1",
      projectId: "project-1",
    });

    expect(result?.error).toBeUndefined();
    expect(result?.data).toEqual({ answer: "ok" });
    expect(calls).toEqual([
      {
        name: "opencrab_query",
        arguments: {
          query: "FMG",
          top_k: 20,
          workspace_id: "workspace-default",
        },
      },
    ]);
  });

  it("redacts endpoint secrets in health output", async () => {
    const { ctx } = createContext({ endpoint: "https://opencrab.sh/api/mcp/test-secret" });
    await plugin.definition.setup(ctx);

    const health = await plugin.definition.onHealth?.();

    expect(health?.details).toMatchObject({ endpoint: "https://opencrab.sh/api/mcp/[REDACTED]" });
    expect(JSON.stringify(health)).not.toContain("test-secret");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type {
  AgentMcpToolDescriptor,
  AgentMcpToolListResponse,
  ExecuteAgentMcpToolResponse,
} from "@paperclipai/shared";
import { agentMcpToolService } from "./agent-mcp-tools.js";
import {
  agentToolCatalogService,
  buildCompactMcpRunContext,
  COMPACT_DESCRIPTION_MAX_CHARS,
  mcpQualifiedToolName,
  parseMcpQualifiedToolName,
} from "./agent-tools.js";
import type { AgentToolDescriptor } from "./plugin-tool-dispatcher.js";

const NO_DB = null as unknown as Db;

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const AGENT_1 = "33333333-3333-4333-8333-333333333333";
const SERVER_X = "44444444-4444-4444-8444-444444444444";
const SERVER_Y = "55555555-5555-4555-8555-555555555555";
const PROJECT_A = "66666666-6666-4666-8666-666666666666";

function mcpTool(overrides: Partial<AgentMcpToolDescriptor> = {}): AgentMcpToolDescriptor {
  return {
    serverId: SERVER_X,
    serverName: "GitHub",
    serverSlug: "github",
    bindingMode: "allowed",
    toolName: "create_issue",
    title: "Create issue",
    description: "Creates a GitHub issue",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    ...overrides,
  };
}

function mcpCatalog(tools: AgentMcpToolDescriptor[]): AgentMcpToolListResponse {
  const byServer = new Map<string, AgentMcpToolDescriptor[]>();
  for (const tool of tools) {
    const list = byServer.get(tool.serverId) ?? [];
    list.push(tool);
    byServer.set(tool.serverId, list);
  }
  return {
    servers: [...byServer.entries()].map(([serverId, serverTools]) => ({
      serverId,
      serverName: serverTools[0]!.serverName,
      serverSlug: serverTools[0]!.serverSlug,
      bindingMode: serverTools[0]!.bindingMode,
      enabled: true,
      toolCount: serverTools.length,
      tools: serverTools,
    })),
    tools,
  };
}

function pluginTool(overrides: Partial<AgentToolDescriptor> = {}): AgentToolDescriptor {
  return {
    name: "acme.linear:search-issues",
    displayName: "Search Linear issues",
    description: "Searches Linear issues by text",
    parametersSchema: { type: "object", properties: { query: { type: "string" } } },
    pluginId: "acme.linear",
    ...overrides,
  };
}

function fakeMcpTools(catalog: AgentMcpToolListResponse) {
  const executeForRun = vi.fn(
    async (): Promise<ExecuteAgentMcpToolResponse> => ({
      ok: true,
      serverId: SERVER_X,
      serverName: "GitHub",
      serverSlug: "github",
      toolName: "create_issue",
      content: "created",
      data: { id: 1 },
      error: null,
    }),
  );
  return {
    listForAgent: vi.fn(async () => catalog),
    executeForRun,
  };
}

function fakeDispatcher(tools: AgentToolDescriptor[]) {
  return {
    listToolsForAgent: vi.fn(() => tools),
    getTool: vi.fn((name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) return null;
      return {
        pluginId: tool.pluginId,
        pluginDbId: tool.pluginId,
        name: tool.name.split(":")[1] ?? tool.name,
        namespacedName: tool.name,
        displayName: tool.displayName,
        description: tool.description,
        parametersSchema: tool.parametersSchema,
      };
    }),
    executeTool: vi.fn(async (namespacedName: string) => ({
      pluginId: "acme.linear",
      toolName: namespacedName,
      result: { content: "plugin-ok", data: { hits: 2 } },
    })),
  };
}

describe("mcp qualified tool names", () => {
  it("round-trips slug and tool name", () => {
    const name = mcpQualifiedToolName("github", "create_issue");
    expect(name).toBe("mcp:github:create_issue");
    expect(parseMcpQualifiedToolName(name)).toEqual({
      serverSlug: "github",
      toolName: "create_issue",
    });
  });

  it("keeps colons inside the tool name", () => {
    expect(parseMcpQualifiedToolName("mcp:srv:a:b")).toEqual({
      serverSlug: "srv",
      toolName: "a:b",
    });
  });

  it("rejects non-mcp and malformed names", () => {
    expect(parseMcpQualifiedToolName("acme.linear:search-issues")).toBeNull();
    expect(parseMcpQualifiedToolName("mcp:")).toBeNull();
    expect(parseMcpQualifiedToolName("mcp:slug-only")).toBeNull();
    expect(parseMcpQualifiedToolName("mcp:slug:")).toBeNull();
  });
});

describe("listMergedIndex", () => {
  it("merges plugin and MCP tools into one compact index", async () => {
    const mcpTools = fakeMcpTools(mcpCatalog([mcpTool()]));
    const catalog = agentToolCatalogService(NO_DB, {
      mcpTools,
      toolDispatcher: fakeDispatcher([pluginTool()]),
      resolveProjectCompanyId: async () => null,
    });

    const index = await catalog.listMergedIndex(COMPANY_A, AGENT_1);

    expect(mcpTools.listForAgent).toHaveBeenCalledWith(AGENT_1, { companyId: COMPANY_A });
    expect(index.counts).toEqual({ plugin: 1, mcp: 1, total: 2 });
    expect(index.tools.map((tool) => tool.name)).toEqual([
      "acme.linear:search-issues",
      "mcp:github:create_issue",
    ]);
    // Compact: no inline schemas anywhere in the index.
    for (const entry of index.tools) {
      expect(entry).not.toHaveProperty("inputSchema");
      expect(entry).not.toHaveProperty("parametersSchema");
      expect(entry.hasInputSchema).toBe(true);
    }
    expect(index.schemaPath).toBe(`/api/companies/${COMPANY_A}/agents/${AGENT_1}/tools/schema`);
    expect(index.executePath).toBe(`/api/companies/${COMPANY_A}/agents/${AGENT_1}/tools/execute`);
  });

  it("returns only plugin tools when the agent has no MCP bindings", async () => {
    const catalog = agentToolCatalogService(NO_DB, {
      mcpTools: fakeMcpTools(mcpCatalog([])),
      toolDispatcher: fakeDispatcher([pluginTool()]),
      resolveProjectCompanyId: async () => null,
    });

    const index = await catalog.listMergedIndex(COMPANY_A, AGENT_1);
    expect(index.counts).toEqual({ plugin: 1, mcp: 0, total: 1 });
    expect(index.tools.every((tool) => tool.source === "plugin")).toBe(true);
  });

  it("works without a plugin dispatcher (MCP only)", async () => {
    const catalog = agentToolCatalogService(NO_DB, {
      mcpTools: fakeMcpTools(mcpCatalog([mcpTool()])),
      resolveProjectCompanyId: async () => null,
    });

    const index = await catalog.listMergedIndex(COMPANY_A, AGENT_1);
    expect(index.counts).toEqual({ plugin: 0, mcp: 1, total: 1 });
  });

  it("trims long descriptions in the compact index", async () => {
    const longDescription = "x".repeat(COMPACT_DESCRIPTION_MAX_CHARS + 100);
    const catalog = agentToolCatalogService(NO_DB, {
      mcpTools: fakeMcpTools(mcpCatalog([mcpTool({ description: longDescription })])),
      resolveProjectCompanyId: async () => null,
    });

    const index = await catalog.listMergedIndex(COMPANY_A, AGENT_1);
    expect(index.tools[0]!.description!.length).toBeLessThanOrEqual(
      COMPACT_DESCRIPTION_MAX_CHARS,
    );
  });
});

describe("getToolSchema", () => {
  it("returns the full schema for a bound MCP tool", async () => {
    const catalog = agentToolCatalogService(NO_DB, {
      mcpTools: fakeMcpTools(mcpCatalog([mcpTool()])),
      resolveProjectCompanyId: async () => null,
    });

    const schema = await catalog.getToolSchema(COMPANY_A, AGENT_1, "mcp:github:create_issue");
    expect(schema.source).toBe("mcp");
    expect(schema.inputSchema).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
    });
    expect(schema.serverSlug).toBe("github");
  });

  it("returns the full schema for a plugin tool", async () => {
    const catalog = agentToolCatalogService(NO_DB, {
      mcpTools: fakeMcpTools(mcpCatalog([])),
      toolDispatcher: fakeDispatcher([pluginTool()]),
      resolveProjectCompanyId: async () => null,
    });

    const schema = await catalog.getToolSchema(COMPANY_A, AGENT_1, "acme.linear:search-issues");
    expect(schema.source).toBe("plugin");
    expect(schema.pluginId).toBe("acme.linear");
    expect(schema.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
    });
  });

  it("404s for tools outside the agent's surface", async () => {
    const catalog = agentToolCatalogService(NO_DB, {
      mcpTools: fakeMcpTools(mcpCatalog([])),
      toolDispatcher: fakeDispatcher([]),
      resolveProjectCompanyId: async () => null,
    });

    await expect(
      catalog.getToolSchema(COMPANY_A, AGENT_1, "mcp:github:create_issue"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      catalog.getToolSchema(COMPANY_A, AGENT_1, "acme.linear:search-issues"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("execute", () => {
  const runContext = { companyId: COMPANY_A, agentId: AGENT_1, runId: "run-1" };

  it("routes MCP tools through the MCP execute path with company+agent scope", async () => {
    const mcpTools = fakeMcpTools(mcpCatalog([mcpTool()]));
    const catalog = agentToolCatalogService(NO_DB, {
      mcpTools,
      toolDispatcher: fakeDispatcher([]),
      resolveProjectCompanyId: async () => null,
    });

    const result = await catalog.execute(runContext, {
      name: "mcp:github:create_issue",
      arguments: { title: "Bug" },
    });

    expect(result).toMatchObject({ ok: true, source: "mcp", content: "created" });
    expect(mcpTools.executeForRun).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: AGENT_1, companyId: COMPANY_A }),
      expect.objectContaining({
        serverName: "github",
        toolName: "create_issue",
        arguments: { title: "Bug" },
      }),
    );
  });

  it("routes plugin tools through the dispatcher with a server-built run context", async () => {
    const dispatcher = fakeDispatcher([pluginTool()]);
    const catalog = agentToolCatalogService(NO_DB, {
      mcpTools: fakeMcpTools(mcpCatalog([])),
      toolDispatcher: dispatcher,
      resolveProjectCompanyId: async () => COMPANY_A,
    });

    const result = await catalog.execute(runContext, {
      name: "acme.linear:search-issues",
      arguments: { query: "bug" },
      projectId: PROJECT_A,
    });

    expect(result).toMatchObject({ ok: true, source: "plugin", content: "plugin-ok" });
    expect(dispatcher.executeTool).toHaveBeenCalledWith(
      "acme.linear:search-issues",
      { query: "bug" },
      { agentId: AGENT_1, runId: "run-1", companyId: COMPANY_A, projectId: PROJECT_A },
    );
  });

  it("requires a company-owned project for plugin tools", async () => {
    const catalog = agentToolCatalogService(NO_DB, {
      mcpTools: fakeMcpTools(mcpCatalog([])),
      toolDispatcher: fakeDispatcher([pluginTool()]),
      resolveProjectCompanyId: async () => COMPANY_B,
    });

    await expect(
      catalog.execute(runContext, { name: "acme.linear:search-issues" }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      catalog.execute(runContext, {
        name: "acme.linear:search-issues",
        projectId: PROJECT_A,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("404s for unknown tools", async () => {
    const catalog = agentToolCatalogService(NO_DB, {
      mcpTools: fakeMcpTools(mcpCatalog([])),
      toolDispatcher: fakeDispatcher([]),
      resolveProjectCompanyId: async () => null,
    });

    await expect(
      catalog.execute(runContext, { name: "mcp:github:create_issue" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

function binding(overrides: {
  companyId: string;
  serverId: string;
  slug: string;
  enabled?: boolean;
  serverEnabled?: boolean;
  allowedTools?: string[];
}) {
  return {
    companyId: overrides.companyId,
    agentId: AGENT_1,
    mcpServerId: overrides.serverId,
    bindingMode: "allowed" as const,
    enabled: overrides.enabled ?? true,
    allowedTools: overrides.allowedTools ?? [],
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    server: {
      id: overrides.serverId,
      companyId: overrides.companyId,
      name: overrides.slug,
      slug: overrides.slug,
      enabled: overrides.serverEnabled ?? true,
      transport: "http",
      cwd: null,
    },
    latestSnapshot: {
      tools: [
        {
          name: "create_issue",
          title: "Create issue",
          description: "desc",
          inputSchema: {},
        },
      ],
    },
  };
}

function serviceWithBindings(
  bindings: unknown[],
  opts: {
    isCompanyMcpClientEnabled?: (companyId: string) => Promise<boolean>;
  } = {},
) {
  const executeTool = vi.fn(async () => ({
    content: "ok",
    data: {},
    error: null,
    logs: [],
  }));
  const telemetry = vi.fn();
  const svc = agentMcpToolService(NO_DB, {
    secrets: null as never,
    mcpServers: {
      listBindingsForAgent: vi.fn(async () => bindings),
      executeTool,
    } as never,
    isCompanyMcpClientEnabled: opts.isCompanyMcpClientEnabled ?? (async () => true),
    telemetry,
  });
  return { svc, executeTool, telemetry };
}

describe("agentMcpToolService company scoping", () => {
  it("intersects the agent's bindings with the requesting company", async () => {
    const { svc } = serviceWithBindings([
      binding({ companyId: COMPANY_A, serverId: SERVER_X, slug: "github" }),
      binding({ companyId: COMPANY_B, serverId: SERVER_Y, slug: "slack" }),
    ]);

    const scoped = await svc.listForAgent(AGENT_1, { companyId: COMPANY_A });
    expect(scoped.servers.map((server) => server.serverSlug)).toEqual(["github"]);

    const unscoped = await svc.listForAgent(AGENT_1);
    expect(unscoped.servers).toHaveLength(2);
  });

  it("refuses to execute a tool from another company's server", async () => {
    const { svc, executeTool } = serviceWithBindings([
      binding({ companyId: COMPANY_B, serverId: SERVER_Y, slug: "slack" }),
    ]);

    await expect(
      svc.executeForRun(
        { agentId: AGENT_1, companyId: COMPANY_A },
        { toolName: "create_issue" },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("executes through the manager path when the binding is company-consistent", async () => {
    const { svc, executeTool } = serviceWithBindings([
      binding({ companyId: COMPANY_A, serverId: SERVER_X, slug: "github" }),
    ]);

    const result = await svc.executeForRun(
      { agentId: AGENT_1, companyId: COMPANY_A },
      { toolName: "create_issue" },
    );
    expect(result.ok).toBe(true);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});

describe("agentMcpToolService per-company gate (NEO-286 D2-5)", () => {
  const gateOnlyFor = (enabledCompanyId: string) => async (companyId: string) =>
    companyId === enabledCompanyId;

  it("returns an empty tool surface when the company gate is off", async () => {
    const { svc } = serviceWithBindings(
      [binding({ companyId: COMPANY_A, serverId: SERVER_X, slug: "github" })],
      { isCompanyMcpClientEnabled: async () => false },
    );

    const catalog = await svc.listForAgent(AGENT_1, { companyId: COMPANY_A });
    expect(catalog.servers).toEqual([]);
    expect(catalog.tools).toEqual([]);
  });

  it("refuses to execute when the company gate is off", async () => {
    const { svc, executeTool, telemetry } = serviceWithBindings(
      [binding({ companyId: COMPANY_A, serverId: SERVER_X, slug: "github" })],
      { isCompanyMcpClientEnabled: async () => false },
    );

    await expect(
      svc.executeForRun(
        { agentId: AGENT_1, companyId: COMPANY_A },
        { toolName: "create_issue" },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(executeTool).not.toHaveBeenCalled();
    expect(telemetry).not.toHaveBeenCalled();
  });

  it("gates unscoped listings by each binding's own company", async () => {
    const { svc } = serviceWithBindings(
      [
        binding({ companyId: COMPANY_A, serverId: SERVER_X, slug: "github" }),
        binding({ companyId: COMPANY_B, serverId: SERVER_Y, slug: "slack" }),
      ],
      { isCompanyMcpClientEnabled: gateOnlyFor(COMPANY_A) },
    );

    const unscoped = await svc.listForAgent(AGENT_1);
    expect(unscoped.servers.map((server) => server.serverSlug)).toEqual(["github"]);
  });
});

describe("agentMcpToolService telemetry (NEO-286 D2-5)", () => {
  it("emits one redacted event per successful call", async () => {
    const { svc, telemetry } = serviceWithBindings([
      binding({ companyId: COMPANY_A, serverId: SERVER_X, slug: "github" }),
    ]);

    await svc.executeForRun(
      { agentId: AGENT_1, companyId: COMPANY_A },
      { toolName: "create_issue", arguments: { apiKey: "sk-super-secret" } },
    );

    expect(telemetry).toHaveBeenCalledTimes(1);
    const event = telemetry.mock.calls[0]![0];
    expect(event).toMatchObject({
      tool: "create_issue",
      server: "github",
      actor: AGENT_1,
      company: COMPANY_A,
      status: "ok",
    });
    expect(typeof event.durationMs).toBe("number");
    // Creds/arguments never ride along on the telemetry event.
    expect(JSON.stringify(event)).not.toContain("sk-super-secret");
  });

  it("emits an error event when the tool call throws, then rethrows", async () => {
    const { svc, executeTool, telemetry } = serviceWithBindings([
      binding({ companyId: COMPANY_A, serverId: SERVER_X, slug: "github" }),
    ]);
    executeTool.mockRejectedValueOnce(new TypeError("boom"));

    await expect(
      svc.executeForRun(
        { agentId: AGENT_1, companyId: COMPANY_A },
        { toolName: "create_issue" },
      ),
    ).rejects.toThrow("boom");

    expect(telemetry).toHaveBeenCalledTimes(1);
    expect(telemetry.mock.calls[0]![0]).toMatchObject({
      tool: "create_issue",
      status: "error",
      errorName: "TypeError",
    });
  });

  it("marks tool-level errors as error outcomes", async () => {
    const { svc, telemetry, executeTool } = serviceWithBindings([
      binding({ companyId: COMPANY_A, serverId: SERVER_X, slug: "github" }),
    ]);
    executeTool.mockResolvedValueOnce({
      content: null,
      data: null,
      error: "tool exploded",
      logs: [],
    });

    const result = await svc.executeForRun(
      { agentId: AGENT_1, companyId: COMPANY_A },
      { toolName: "create_issue" },
    );
    expect(result.ok).toBe(false);
    expect(telemetry.mock.calls[0]![0]).toMatchObject({ status: "error" });
    expect(telemetry.mock.calls[0]![0].errorName).toBeUndefined();
  });
});

describe("buildCompactMcpRunContext", () => {
  it("drops schemas and per-server tool arrays", () => {
    const compact = buildCompactMcpRunContext(mcpCatalog([mcpTool()]));
    expect(compact.servers[0]).not.toHaveProperty("tools");
    expect(compact.servers[0]).toMatchObject({ serverSlug: "github", toolCount: 1 });
    expect(compact.tools[0]).not.toHaveProperty("inputSchema");
    expect(compact.tools[0]).toMatchObject({
      name: "mcp:github:create_issue",
      toolName: "create_issue",
      serverName: "GitHub",
    });
  });
});

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type { McpServer as McpServerRecord } from "@paperclipai/shared";
import { mcpClientManager } from "../services/mcp-client-manager.js";
import { mcpServerService } from "../services/mcp-servers.js";
import type { secretService } from "../services/secrets.js";

// NEO-351 acceptance: connect to a throwaway http MCP server, list + call a
// tool scoped to one company, and prove the pool keeps companies apart.

const seenAuthHeaders: Array<string | undefined> = [];

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function buildThrowawayMcpServer(): McpServer {
  const mcp = new McpServer({ name: "throwaway-mcp", version: "1.0.0" });
  mcp.registerTool(
    "echo",
    {
      description: "Echoes the provided text back.",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
  );
  return mcp;
}

let httpServer: Server;
let endpoint: string;

beforeAll(async () => {
  // Stateless streamable-http MCP server: fresh server+transport per request.
  httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      seenAuthHeaders.push(req.headers.authorization);
      const body = await readJsonBody(req);
      const mcp = buildThrowawayMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${address.port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function integrationManager() {
  // 127.0.0.1 is exactly what the SSRF guard denies by default, so the
  // throwaway-server tests opt in explicitly.
  return mcpClientManager({
    allowPrivateEndpoints: true,
    reapIntervalMs: 0,
    healthCheckIntervalMs: 0,
    connectTimeoutMs: 15_000,
  });
}

describe("mcp-client-manager against a throwaway http MCP server", () => {
  it("connects, lists tools, and calls a tool scoped to one company", async () => {
    const manager = integrationManager();
    try {
      const pooled = await manager.acquire({
        companyId: "company-a",
        mcpServerId: "server-1",
        transport: "http",
        endpoint,
        headers: { Authorization: "Bearer company-a-token" },
      });

      const listed = await pooled.client.listTools();
      const names = listed.tools
        .map((tool) => (tool && typeof tool === "object" ? (tool as { name?: string }).name : null))
        .filter(Boolean);
      expect(names).toContain("echo");

      const result = (await pooled.client.callTool({
        name: "echo",
        arguments: { text: "hi" },
      })) as { content?: Array<{ type: string; text?: string }> };
      expect(result.content?.[0]?.text).toBe("echo:hi");

      expect(manager.stats()).toEqual({ companies: 1, clients: 1 });
      // The per-target Authorization header reached the wire.
      expect(seenAuthHeaders).toContain("Bearer company-a-token");
    } finally {
      await manager.shutdown();
    }
  });

  it("keeps company pools isolated end-to-end", async () => {
    const manager = integrationManager();
    try {
      const a = await manager.acquire({
        companyId: "company-a",
        mcpServerId: "server-1",
        transport: "http",
        endpoint,
      });
      const b = await manager.acquire({
        companyId: "company-b",
        mcpServerId: "server-1",
        transport: "http",
        endpoint,
      });
      expect(a.client).not.toBe(b.client);
      expect(manager.stats()).toEqual({ companies: 2, clients: 2 });

      await manager.invalidateCompany("company-b");
      expect(manager.stats()).toEqual({ companies: 1, clients: 1 });

      // Company A's pooled client keeps working after B is torn down.
      const result = (await a.client.callTool({
        name: "echo",
        arguments: { text: "still-alive" },
      })) as { content?: Array<{ type: string; text?: string }> };
      expect(result.content?.[0]?.text).toBe("echo:still-alive");
    } finally {
      await manager.shutdown();
    }
  });
});

describe("mcpServerService executeTool over http (the executing client)", () => {
  function serviceWithManager(manager = integrationManager()) {
    const secretsStub = {
      resolveEnvBindings: async () => ({ env: {} }),
      normalizeEnvBindingsForPersistence: async (
        _companyId: string,
        env: Record<string, unknown>,
      ) => env,
    } as unknown as ReturnType<typeof secretService>;
    const svc = mcpServerService({} as unknown as Db, {
      secrets: secretsStub,
      mcpClients: manager,
    });
    return { svc, manager };
  }

  function httpServerRecord(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
    const now = new Date();
    return {
      id: "srv-http-1",
      companyId: "company-a",
      name: "Throwaway",
      slug: "throwaway",
      description: null,
      transport: "http",
      command: null,
      args: [],
      cwd: null,
      url: endpoint,
      headers: {},
      env: {},
      credentialSecretRef: null,
      enabled: true,
      lastHealthStatus: "unknown",
      lastHealthcheckAt: null,
      lastDiscoveryAt: null,
      lastError: null,
      metadata: {},
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it("executes an http MCP tool through the pooled client", async () => {
    const { svc, manager } = serviceWithManager();
    try {
      const outcome = await svc.executeTool(httpServerRecord(), {
        toolName: "echo",
        arguments: { text: "from-service" },
      });
      expect(outcome.error).toBeNull();
      expect(outcome.content).toBe("echo:from-service");
      expect(manager.stats()).toEqual({ companies: 1, clients: 1 });
    } finally {
      await manager.shutdown();
    }
  });

  it("blocks loopback endpoints when the SSRF guard is on (default manager config)", async () => {
    const guarded = mcpClientManager({ reapIntervalMs: 0, healthCheckIntervalMs: 0 });
    const { svc, manager } = serviceWithManager(guarded);
    try {
      await expect(
        svc.executeTool(httpServerRecord(), { toolName: "echo", arguments: { text: "x" } }),
      ).rejects.toMatchObject({ code: "endpoint_denied" });
    } finally {
      await manager.shutdown();
    }
  });
});

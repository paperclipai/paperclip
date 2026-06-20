import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHttpServer } from "./http.js";

let upstream: Server; // mock Paperclip REST API
let mcp: Server;      // our external MCP server
let mcpUrl: string;

beforeAll(async () => {
  // Mock Paperclip API: GET /api/agents/me → identity derived from the bearer.
  upstream = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    if (req.url === "/api/agents/me" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: `agent-for:${auth}`, authSeen: auth }));
      return;
    }
    if (req.url?.startsWith("/api/companies/co-int/issues") && req.method === "GET") {
      const reqUrl = new URL(req.url, "http://x");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        company: req.headers["x-paperclip-company"] ?? null,
        authSeen: auth,
        status: reqUrl.searchParams.get("status"),
        limit: reqUrl.searchParams.get("limit"),
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  mcp = createHttpServer({
    apiUrl: `http://127.0.0.1:${upstreamPort}`, // factory normalizes → .../api
    apiKey: null,
    companyId: "co-int",
  });
  await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", () => r()));
  mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((r) => mcp.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

async function callGetAgentAs(token: string): Promise<string> {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: token } },
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "get_agent", arguments: { agent_id: "me" } }) as CallToolResult;
    const first = result.content[0];
    if (first.type !== "text") throw new Error(`Expected text content, got ${first.type}`);
    return first.text;
  } finally {
    await client.close();
  }
}

async function callToolAs(token: string, name: string, args: Record<string, unknown>): Promise<string> {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: token } },
  });
  await client.connect(transport);
  try {
    const result: any = await client.callTool({ name, arguments: args });
    return result.content[0].text as string;
  } finally {
    await client.close();
  }
}

describe("multi-tenant streamable-HTTP", () => {
  it("two different bearers resolve to two different identities", async () => {
    const a = await callGetAgentAs("Bearer pcp_AAAA");
    const b = await callGetAgentAs("Bearer pcp_BBBB");
    expect(a).toContain("agent-for:Bearer pcp_AAAA");
    expect(b).toContain("agent-for:Bearer pcp_BBBB");
    expect(a).not.toEqual(b);
  }, 15000);

  it("tools/list advertises get_agent", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: "Bearer pcp_X" } },
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("get_agent");
    } finally {
      await client.close();
    }
  }, 15000);
});

describe("company-scoped tool wiring (list_issues)", () => {
  it("scopes by company + forwards bearer + query per tenant", async () => {
    const a = JSON.parse(await callToolAs("Bearer pcp_AAAA", "list_issues", { limit: 7 }));
    const b = JSON.parse(await callToolAs("Bearer pcp_BBBB", "list_issues", {}));
    expect(a.company).toBe("co-int");
    expect(a.authSeen).toBe("Bearer pcp_AAAA");
    expect(a.status).toBe("todo,in_progress");
    expect(a.limit).toBe("7");
    expect(b.authSeen).toBe("Bearer pcp_BBBB");
    expect(b.company).toBe("co-int");
    expect(b.limit).toBe("50");
  }, 15000);

  it("tools/list advertises the full external surface", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: "Bearer pcp_X" } },
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const expected of [
        "list_issues", "get_issue", "create_issue", "update_issue",
        "checkout_issue", "release_issue", "delete_issue", "comment_on_issue",
        "paperclip_search_issues", "list_projects", "get_project",
        "create_project", "update_project", "list_goals", "create_goal", "update_goal",
        "list_agents", "invoke_agent_heartbeat",
        "list_approvals", "approve", "reject", "request_approval_revision",
        "get_dashboard", "get_cost_summary", "list_activity",
      ]) {
        expect(names).toContain(expected);
      }
      expect(names).toContain("get_agent");
      expect(new Set(names).size).toBeGreaterThanOrEqual(25);
    } finally {
      await client.close();
    }
  }, 15000);
});

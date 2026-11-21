import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectToolRoutes } from "../routes/project-tools.js";
import { projectToolDefinitions } from "../services/project-tools.js";

vi.mock("../services/project-tool-context.js", () => ({
  projectToolContext: vi.fn(async () => ({
    run: { id: "run", companyId: "company", agentId: "agent" },
    issue: { id: "issue", workMode: "standard" },
    userId: null,
    localTrusted: false,
  })),
}));
vi.mock("../routes/authz.js", () => ({ assertCompanyAccess: vi.fn() }));
vi.mock("../services/project-tools.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/project-tools.js")>();
  return { ...actual, projectToolDefinitions: vi.fn(actual.projectToolDefinitions) };
});

const app = express()
  .use(express.json())
  .use((req, _res, next) => {
    req.actor = { type: "agent", source: "agent_jwt", runId: "run", agentId: "agent", companyId: "company" } as typeof req.actor;
    next();
  })
  .use(projectToolRoutes({} as never));

const post = (method: string, params?: unknown) =>
  request(app).post("/mcp/project-tools").send({ jsonrpc: "2.0", id: 7, method, params });

beforeEach(() => vi.clearAllMocks());

describe("project tools MCP error handling", () => {
  it("answers tools/list with the discovered tools", async () => {
    const response = await post("tools/list");
    expect(response.status).toBe(200);
    expect(response.body.result.tools.length).toBeGreaterThan(0);
  });

  it.each(["tools/list", "tools/call"])("returns a JSON-RPC error instead of HTTP 500 when tool definitions cannot be built: %s", async (method) => {
    vi.mocked(projectToolDefinitions).mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'push')");
    });
    const response = await post(method, method === "tools/call" ? { name: "list_projects", arguments: {} } : undefined);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ jsonrpc: "2.0", id: 7 });
    expect(response.body.error).toMatchObject({ code: -32603, message: expect.stringContaining("push") });
    expect(response.body.result).toBeUndefined();
  });

  it("rejects unknown methods without building tool definitions", async () => {
    const response = await post("tools/describe");
    expect(response.status).toBe(200);
    expect(response.body.error).toMatchObject({ code: -32601 });
    expect(projectToolDefinitions).not.toHaveBeenCalled();
  });
});

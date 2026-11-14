import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mockProjectToolContext = vi.hoisted(() => vi.fn());
const mockAssertCompanyAccess = vi.hoisted(() => vi.fn());
const mockProjectToolDefinitions = vi.hoisted(() => vi.fn());
const mockCallProjectTool = vi.hoisted(() => vi.fn());

vi.mock("../services/project-tool-context.js", () => ({
  projectToolContext: mockProjectToolContext,
}));

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: mockAssertCompanyAccess,
}));

vi.mock("../services/project-tools.js", () => ({
  projectToolDefinitions: mockProjectToolDefinitions,
  callProjectTool: mockCallProjectTool,
}));

import { projectToolRoutes } from "../routes/project-tools.js";

describe("POST /api/mcp/project-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectToolContext.mockResolvedValue({
      run: { companyId: "company-1", agentId: "agent-1" },
      issue: { id: "issue-1", workMode: "standard", conversationAgentId: null },
    });
    mockAssertCompanyAccess.mockReturnValue(undefined);
  });

  it("returns tool definitions for tools/list when schema generation succeeds", async () => {
    mockProjectToolDefinitions.mockReturnValue([
      { name: "create_project", description: "Create project", inputSchema: { type: "object" } },
    ]);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_jwt" } as never;
      next();
    });
    app.use("/api", projectToolRoutes({} as Db));

    const response = await request(app)
      .post("/api/mcp/project-tools")
      .send({ jsonrpc: "2.0", id: 7, method: "tools/list" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {
        tools: [{ name: "create_project", description: "Create project", inputSchema: { type: "object" } }],
      },
    });
  });

  it("returns a JSON-RPC error instead of 500 when projectToolDefinitions throws on tools/list", async () => {
    mockProjectToolDefinitions.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'push')");
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_jwt" } as never;
      next();
    });
    app.use("/api", projectToolRoutes({} as Db));

    const response = await request(app)
      .post("/api/mcp/project-tools")
      .send({ jsonrpc: "2.0", id: 8, method: "tools/list" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      jsonrpc: "2.0",
      id: 8,
      error: {
        code: -32603,
        message: "Cannot read properties of undefined (reading 'push')",
      },
    });
  });
});

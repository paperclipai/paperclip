import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const mcpHandler = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/mcp-server", async () => {
  return {
    normalizeApiUrl(value: string) {
      const trimmed = value.replace(/\/+$/, "");
      return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
    },
    handlePaperclipStreamableHttpRequest: mcpHandler,
  };
});

async function createApp(actor: Express.Request["actor"]) {
  const { mcpRoutes } = await import("../routes/mcp.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(mcpRoutes());
  app.use(errorHandler);
  return app;
}

describe("mcp routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_MCP_API_URL;
    delete process.env.PAPERCLIP_AGENT_ID;
    delete process.env.PAPERCLIP_MCP_AGENT_ID;
    delete process.env.PAPERCLIP_COMPANY_ID;
    delete process.env.PAPERCLIP_RUN_ID;
    mcpHandler.mockImplementation(async (_config, _req, res) => {
      res.status(200).json({ ok: true });
    });
  });

  it("rejects unauthenticated MCP requests", async () => {
    const app = await createApp({ type: "none", source: "none" });

    const res = await request(app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    expect(res.status).toBe(401);
    expect(mcpHandler).not.toHaveBeenCalled();
  });

  it("derives MCP config from authenticated agent requests", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      source: "agent_key",
    });

    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer token-1")
      .set("Host", "paperclip.example")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    expect(res.status).toBe(200);
    expect(mcpHandler).toHaveBeenCalledTimes(1);
    expect(mcpHandler.mock.calls[0]?.[0]).toEqual({
      apiUrl: "http://paperclip.example/api",
      apiKey: "token-1",
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
  });

  it("lets board API keys scope company and agent by headers", async () => {
    process.env.PAPERCLIP_MCP_API_URL = "https://paperclip.ing";
    const app = await createApp({
      type: "board",
      userId: "ceo-1",
      companyIds: ["company-a", "company-b"],
      isInstanceAdmin: true,
      source: "board_key",
    });

    const res = await request(app)
      .post("/api/mcp")
      .set("Authorization", "Bearer board-token")
      .set("X-Paperclip-Company-Id", "company-b")
      .set("X-Paperclip-Agent-Id", "agent-ceo")
      .set("X-Paperclip-Run-Id", "run-ceo")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(res.status).toBe(200);
    expect(mcpHandler.mock.calls[0]?.[0]).toEqual({
      apiUrl: "https://paperclip.ing/api",
      apiKey: "board-token",
      companyId: "company-b",
      agentId: "agent-ceo",
      runId: "run-ceo",
    });
  });

  it("returns method guidance for non-POST MCP requests", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app)
      .get("/mcp")
      .set("Authorization", "Bearer token-1");

    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
  });
});

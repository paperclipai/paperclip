import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpRoutes } from "../routes/mcp.js";

function createApp(actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/mcp", mcpRoutes({ serverPort: 3100 }));
  return app;
}

function extractJsonRpcMessage(response: request.Response) {
  if (response.body && typeof response.body === "object" && Object.keys(response.body).length > 0) {
    return response.body as Record<string, unknown>;
  }

  const dataLine = response.text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`Missing MCP data frame in response: ${response.text}`);
  }
  return JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
}

async function initializeSession(
  app: express.Express,
  headers: Record<string, string> = {},
) {
  const response = await request(app)
    .post("/mcp")
    .set({
      Accept: "application/json, text/event-stream",
      ...headers,
    })
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "paperclip-test-client",
          version: "1.0.0",
        },
      },
    });

  expect(response.status).toBe(200);
  const sessionId = response.header["mcp-session-id"];
  expect(sessionId).toBeTruthy();
  return String(sessionId);
}

describe("mcp routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes a session and lists tools over HTTP", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
    });

    const sessionId = await initializeSession(app, {
      Authorization: "Bearer token-123",
    });

    await request(app)
      .post("/mcp")
      .set({
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer token-123",
        "mcp-session-id": sessionId,
      })
      .send({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })
      .expect(202);

    const response = await request(app)
      .post("/mcp")
      .set({
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer token-123",
        "mcp-session-id": sessionId,
      })
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });

    const message = extractJsonRpcMessage(response);
    expect(response.status).toBe(200);
    expect((message.result as { tools: unknown[] }).tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "paperclipMe" }),
        expect.objectContaining({ name: "paperclipApiRequest" }),
      ]),
    );
  });

  it("forwards request auth into the existing REST-backed tool client", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "agent-1", role: "ceo" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp({
      type: "none",
      source: "none",
    });

    const sessionId = await initializeSession(app, {
      Authorization: "Bearer route-token-123",
    });

    await request(app)
      .post("/mcp")
      .set({
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer route-token-123",
        "mcp-session-id": sessionId,
      })
      .send({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })
      .expect(202);

    const response = await request(app)
      .post("/mcp")
      .set({
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer route-token-123",
        "mcp-session-id": sessionId,
      })
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "paperclipMe",
          arguments: {},
        },
      });

    extractJsonRpcMessage(response);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:3100/api/agents/me");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer route-token-123",
    );
  });
});

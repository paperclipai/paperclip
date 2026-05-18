import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __test as shim } from "./paperclip-tools-mcp-shim.js";

const { planExposedTools, normalizeInputSchema, trimTrailingSlash, fetchPaperclipTools, callPaperclipTool } = shim;

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface FakeServer {
  url: string;
  requests: RecordedRequest[];
  setListResponse(payload: unknown, status?: number): void;
  setCallResponse(payload: unknown, status?: number): void;
  close(): Promise<void>;
}

async function startFakePaperclip(): Promise<FakeServer> {
  let listResponse: { status: number; body: string } = {
    status: 200,
    body: JSON.stringify([]),
  };
  let callResponse: { status: number; body: string } = {
    status: 200,
    body: JSON.stringify({ pluginId: "x", toolName: "x", result: { content: "ok" } }),
  };

  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: { ...req.headers } as Record<string, string>,
        body,
      });
      if (req.method === "GET" && req.url?.endsWith("/tools")) {
        res.writeHead(listResponse.status, { "content-type": "application/json" });
        res.end(listResponse.body);
        return;
      }
      if (req.method === "POST" && req.url?.endsWith("/tool-call")) {
        res.writeHead(callResponse.status, { "content-type": "application/json" });
        res.end(callResponse.body);
        return;
      }
      res.writeHead(404).end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind fake paperclip server");
  }
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    requests,
    setListResponse(payload: unknown, status = 200) {
      listResponse = { status, body: typeof payload === "string" ? payload : JSON.stringify(payload) };
    },
    setCallResponse(payload: unknown, status = 200) {
      callResponse = { status, body: typeof payload === "string" ? payload : JSON.stringify(payload) };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("paperclip-tools-mcp-shim helpers", () => {
  describe("normalizeInputSchema", () => {
    it("normalizes a missing schema to an empty object schema", () => {
      expect(normalizeInputSchema(undefined)).toEqual({ type: "object", properties: {} });
      expect(normalizeInputSchema(null)).toEqual({ type: "object", properties: {} });
      expect(normalizeInputSchema("not-an-object")).toEqual({ type: "object", properties: {} });
    });

    it("preserves a paperclip parametersSchema with required array", () => {
      const schema = {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string", description: "x" } },
      };
      expect(normalizeInputSchema(schema)).toEqual(schema);
    });
  });

  describe("planExposedTools", () => {
    it("exposes bare names when there are no collisions", () => {
      const { exposed, collisions } = planExposedTools([
        {
          name: "paperclip-plugin-hindsight:hindsight_recall",
          description: "Search memory",
          parametersSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
        },
        {
          name: "paperclip-plugin-hindsight:hindsight_retain",
          description: "Save memory",
          parametersSchema: { type: "object", required: ["content"], properties: { content: { type: "string" } } },
        },
      ]);
      expect(collisions).toEqual([]);
      expect(exposed.map((t) => [t.exposedName, t.fullName])).toEqual([
        ["hindsight_recall", "paperclip-plugin-hindsight:hindsight_recall"],
        ["hindsight_retain", "paperclip-plugin-hindsight:hindsight_retain"],
      ]);
    });

    it("falls back to plugin-prefixed names on bare-name collisions and reports them", () => {
      const { exposed, collisions } = planExposedTools([
        { name: "paperclip-plugin-hindsight:hindsight_recall" },
        { name: "paperclip-plugin-other:hindsight_recall" },
        { name: "paperclip-plugin-other:unique_tool" },
      ]);
      expect(collisions).toEqual(["hindsight_recall", "hindsight_recall"]);
      expect(exposed.map((t) => t.exposedName)).toEqual([
        "paperclip_plugin_hindsight_hindsight_recall",
        "paperclip_plugin_other_hindsight_recall",
        "unique_tool",
      ]);
    });
  });

  describe("trimTrailingSlash", () => {
    it("removes trailing slashes idempotently", () => {
      expect(trimTrailingSlash("http://x/")).toBe("http://x");
      expect(trimTrailingSlash("http://x///")).toBe("http://x");
      expect(trimTrailingSlash("http://x")).toBe("http://x");
    });
  });
});

describe("paperclip-tools-mcp-shim HTTP behaviour", () => {
  let server: FakeServer;

  beforeAll(async () => {
    server = await startFakePaperclip();
  });

  afterAll(async () => {
    await server.close();
  });

  it("lists agent-scoped tools and forwards the bearer token", async () => {
    server.setListResponse([
      {
        name: "paperclip-plugin-hindsight:hindsight_recall",
        description: "Recall",
        parametersSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
      },
    ]);
    const tools = await fetchPaperclipTools({
      apiUrl: server.url,
      apiKey: "token-123",
      companyId: "company-uuid",
      agentId: "agent-uuid",
    });
    expect(tools.map((t) => t.name)).toEqual(["paperclip-plugin-hindsight:hindsight_recall"]);
    const listRequest = server.requests.find((r) => r.method === "GET");
    expect(listRequest).toBeTruthy();
    expect(listRequest?.headers.authorization).toBe("Bearer token-123");
    expect(listRequest?.url).toBe("/api/companies/company-uuid/agents/agent-uuid/tools");
  });

  it("forwards tool-call with namespaced tool name and run-id header, and translates result content", async () => {
    server.setCallResponse({
      pluginId: "paperclip-plugin-hindsight",
      toolName: "hindsight_recall",
      result: { content: "recalled-content" },
    });
    const result = await callPaperclipTool({
      apiUrl: server.url,
      apiKey: "token-x",
      companyId: "co",
      agentId: "ag",
      runId: "run-abc",
      toolName: "paperclip-plugin-hindsight:hindsight_recall",
      parameters: { query: "what is up" },
    });
    expect(result).toEqual({ text: "recalled-content", isError: false });
    const callRequest = server.requests.find((r) => r.method === "POST");
    expect(callRequest?.headers["x-paperclip-run-id"]).toBe("run-abc");
    expect(callRequest?.headers.authorization).toBe("Bearer token-x");
    expect(callRequest?.url).toBe("/api/companies/co/agents/ag/tool-call");
    expect(JSON.parse(callRequest?.body ?? "{}")).toEqual({
      tool: "paperclip-plugin-hindsight:hindsight_recall",
      parameters: { query: "what is up" },
    });
  });

  it("translates an HTTP 401 into an MCP tool error rather than throwing", async () => {
    server.setCallResponse("Unauthorized", 401);
    const result = await callPaperclipTool({
      apiUrl: server.url,
      apiKey: "expired",
      companyId: "co",
      agentId: "ag",
      toolName: "paperclip-plugin-hindsight:hindsight_recall",
      parameters: {},
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("HTTP 401");
  });

  it("translates a plugin-side `result.error` into an MCP tool error", async () => {
    server.setCallResponse({
      pluginId: "x",
      toolName: "hindsight_recall",
      result: { content: "partial", error: "downstream failure" },
    });
    const result = await callPaperclipTool({
      apiUrl: server.url,
      apiKey: "token-x",
      companyId: "co",
      agentId: "ag",
      toolName: "paperclip-plugin-hindsight:hindsight_recall",
      parameters: {},
    });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("partial");
  });
});

describe("paperclip-tools-mcp-shim env handling", () => {
  it("surfaces a clear missing-env error from fetchPaperclipTools when called with an empty URL", async () => {
    await expect(
      fetchPaperclipTools({ apiUrl: "http://127.0.0.1:1", apiKey: "x", companyId: "c", agentId: "a" }),
    ).rejects.toThrow();
  });
});

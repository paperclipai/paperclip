/**
 * Integration test for the plugin-tools MCP bridge.
 *
 * Spawns the real bridge process as a stdio child, connects an in-process
 * MCP client to it, and verifies that `tools/list` and `tools/call`
 * round-trip through a fake Paperclip API server.
 *
 * This is the end-to-end proof that `buildPluginToolsMcpServer` + the
 * bridge entrypoint correctly bridge a CLI child to the host registry,
 * for any MCP-aware adapter (Claude, Gemini, Codex, OpenCode).
 *
 * @see KSI-664 — design decision B.1.a
 * @see KSI-698 — implementation
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildPluginToolsMcpServer } from "./plugin-tools-mcp.js";

interface ToolCall {
  tool: string;
  parameters: unknown;
  runContext: unknown;
}

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const API_KEY = "fake-bridge-jwt";

interface FakeServer {
  url: string;
  calls: ToolCall[];
  close: () => Promise<void>;
}

async function startFakeApi(): Promise<FakeServer> {
  const calls: ToolCall[] = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${API_KEY}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/plugins/tools")) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          {
            name: "demo.plugin:echo",
            displayName: "echo",
            description: "Echo back the input message.",
            parametersSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
            pluginId: "demo.plugin",
          },
        ]),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/api/plugins/tools/execute") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as ToolCall;
        calls.push(parsed);
        res.setHeader("content-type", "application/json");
        const message =
          parsed.parameters &&
          typeof parsed.parameters === "object" &&
          "message" in (parsed.parameters as Record<string, unknown>)
            ? String((parsed.parameters as Record<string, unknown>).message)
            : "";
        res.end(
          JSON.stringify({
            pluginId: "demo.plugin",
            toolName: "echo",
            result: {
              content: [{ type: "text", text: `echo: ${message}` }],
            },
          }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake API failed to bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("plugin-tools MCP bridge integration", () => {
  let api: FakeServer;

  beforeAll(async () => {
    api = await startFakeApi();
  });

  afterAll(async () => {
    if (api) await api.close();
  });

  it("lists tools and round-trips a call through the bridge", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const compiledBridge = path.resolve(here, "../dist/bridge/main.js");

    const spec = buildPluginToolsMcpServer({
      runContext: {
        companyId: COMPANY_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        projectId: PROJECT_ID,
      },
      apiUrl: api.url,
      apiKey: API_KEY,
      bridgeScriptPath: compiledBridge,
    });

    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: spec.env,
    });

    const client = new Client(
      { name: "integration-test", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(transport);

    try {
      const list = await client.listTools();
      expect(list.tools.length).toBe(1);
      expect(list.tools[0].name).toBe("demo.plugin:echo");
      expect(list.tools[0].description).toContain("Echo back");
      expect(list.tools[0].inputSchema).toEqual({
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      });

      const callResult = await client.callTool({
        name: "demo.plugin:echo",
        arguments: { message: "hello plugin tools" },
      });
      expect(callResult.isError).toBeFalsy();
      expect(callResult.content).toEqual([
        { type: "text", text: "echo: hello plugin tools" },
      ]);

      // The server must see the runContext exactly as encoded.
      expect(api.calls).toHaveLength(1);
      expect(api.calls[0]).toMatchObject({
        tool: "demo.plugin:echo",
        parameters: { message: "hello plugin tools" },
        runContext: {
          companyId: COMPANY_ID,
          agentId: AGENT_ID,
          runId: RUN_ID,
          projectId: PROJECT_ID,
        },
      });
    } finally {
      await client.close();
    }
  }, 20_000);
});

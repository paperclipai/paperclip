#!/usr/bin/env node
import http from "node:http";
import {
  MCP_FIXTURE_PROTOCOL_VERSION,
  createFixtureState,
  executeFixtureTool,
  listTools,
} from "../catalog.mjs";

const state = createFixtureState();
const port = Number(process.env.PORT ?? 0);
const host = process.env.HOST ?? "127.0.0.1";

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function mcpToolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function sendMcpError(res, id, code, message, data = undefined) {
  sendJson(res, 200, {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, protocol: MCP_FIXTURE_PROTOCOL_VERSION, transport: "http" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/catalog") {
      sendJson(res, 200, { ok: true, tools: listTools({ schemaVariant: state.schemaVariant }).filter((tool) => tool.transport === "http") });
      return;
    }
    if (req.method === "POST" && url.pathname === "/mcp") {
      const body = await readJson(req);
      const params = body.params && typeof body.params === "object" ? body.params : {};
      if (body.method === "tools/list") {
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: {
            tools: listTools({ schemaVariant: state.schemaVariant }).filter((tool) => tool.transport === "http"),
          },
        });
        return;
      }
      if (body.method !== "tools/call" || typeof params.name !== "string") {
        sendMcpError(res, body.id, -32601, "Method not found");
        return;
      }
      const response = await executeFixtureTool(params.name, params.arguments ?? {}, state, {
        secrets: process.env,
      });
      if (!response.ok) {
        sendMcpError(res, body.id, -32000, response.error?.message ?? "Fixture tool failed", response.error);
        return;
      }
      sendJson(res, 200, { jsonrpc: "2.0", id: body.id ?? null, result: mcpToolResult(response.result) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/tools/call") {
      const body = await readJson(req);
      const response = await executeFixtureTool(body.name, body.input ?? {}, state, {
        secrets: process.env,
      });
      sendJson(res, response.ok ? 200 : 422, response);
      return;
    }
    sendJson(res, 404, { ok: false, error: { code: "not_found", message: `${req.method} ${url.pathname}` } });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: { code: "fixture_error", message: String(error?.message ?? error) } });
  }
});

server.listen(port, host, () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ event: "ready", host, port: address.port })}\n`);
});

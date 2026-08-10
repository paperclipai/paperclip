#!/usr/bin/env node
import { createInterface } from "node:readline";
import {
  MCP_FIXTURE_PROTOCOL_VERSION,
  createFixtureState,
  executeFixtureTool,
  listTools,
} from "../catalog.mjs";

const state = createFixtureState();

function mcpToolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

async function handleJsonRpcRequest(request) {
  if (request.method === "notifications/initialized") return null;
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "paperclip-smoke-lab-stdio-fixture", version: "1.0.0" },
      },
    };
  }
  if (request.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: { tools: listTools({ schemaVariant: state.schemaVariant }).filter((tool) => tool.transport === "stdio") },
    };
  }
  if (request.method === "tools/call") {
    const params = request.params && typeof request.params === "object" ? request.params : {};
    const response = await executeFixtureTool(params.name, params.arguments ?? {}, state, {
      secrets: process.env,
    });
    if (!response.ok) {
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32000, message: response.error?.message ?? "Fixture tool failed", data: response.error },
      };
    }
    return { jsonrpc: "2.0", id: request.id ?? null, result: mcpToolResult(response.result) };
  }
  return {
    jsonrpc: "2.0",
    id: request.id ?? null,
    error: { code: -32601, message: `Unknown method ${request.method}` },
  };
}

async function handleRequest(request) {
  if (request.jsonrpc === "2.0") return handleJsonRpcRequest(request);
  if (request.method === "health") {
    return { id: request.id ?? null, ok: true, protocol: MCP_FIXTURE_PROTOCOL_VERSION, transport: "stdio" };
  }
  if (request.method === "list_tools") {
    return { id: request.id ?? null, ok: true, tools: listTools({ schemaVariant: state.schemaVariant }).filter((tool) => tool.transport === "stdio") };
  }
  if (request.method === "call_tool") {
    const response = await executeFixtureTool(request.params?.name, request.params?.input ?? {}, state, {
      secrets: process.env,
    });
    return { id: request.id ?? null, ...response };
  }
  return { id: request.id ?? null, ok: false, error: { code: "unknown_method", message: `Unknown method ${request.method}` } };
}

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  let id = null;
  try {
    const request = JSON.parse(line);
    id = request.id ?? null;
    const response = await handleRequest(request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id, ok: false, error: { code: "bad_request", message: String(error?.message ?? error) } })}\n`);
  }
});

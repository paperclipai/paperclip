#!/usr/bin/env node
import { createInterface } from "node:readline";
import {
  MCP_FIXTURE_PROTOCOL_VERSION,
  createFixtureState,
  executeFixtureTool,
  listTools,
} from "../catalog.mjs";

const state = createFixtureState();

async function handleRequest(request) {
  if (request.method === "health") {
    return { ok: true, protocol: MCP_FIXTURE_PROTOCOL_VERSION, transport: "stdio" };
  }
  if (request.method === "list_tools") {
    return { ok: true, tools: listTools({ schemaVariant: state.schemaVariant }).filter((tool) => tool.transport === "stdio") };
  }
  if (request.method === "call_tool") {
    return executeFixtureTool(request.params?.name, request.params?.input ?? {}, state, {
      secrets: process.env,
    });
  }
  return { ok: false, error: { code: "unknown_method", message: `Unknown method ${request.method}` } };
}

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  const id = (() => {
    try {
      return JSON.parse(line).id ?? null;
    } catch {
      return null;
    }
  })();
  try {
    const request = JSON.parse(line);
    const response = await handleRequest(request);
    process.stdout.write(`${JSON.stringify({ id, ...response })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id, ok: false, error: { code: "bad_request", message: String(error?.message ?? error) } })}\n`);
  }
});

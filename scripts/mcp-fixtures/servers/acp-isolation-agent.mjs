#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const sessions = new Map();
const childProcesses = new Set();

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function withTimeout(promise, label, timeoutMs = 5_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      timer.unref();
    }),
  ]);
}

async function inspectStdioServer(server) {
  if (!server || typeof server !== "object" || "type" in server) {
    throw new Error("ACP isolation fixture only supports stdio MCP servers");
  }

  const serverEnv = Object.fromEntries(
    (server.env ?? []).map((entry) => [entry.name, entry.value]),
  );
  const child = spawn(server.command, server.args ?? [], {
    env: { ...process.env, ...serverEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  childProcesses.add(child);

  let nextId = 1;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });

  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  const request = (method, params = {}) =>
    withTimeout(
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
      `MCP ${method}`,
    );

  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "paperclip-acp-isolation-fixture", version: "1.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const toolsResult = await request("tools/list");

  return {
    child,
    observation: {
      name: server.name,
      tools: toolsResult.tools.map((tool) => tool.name),
    },
  };
}

async function handleRequest(request) {
  if (request.method === "initialize") {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { close: {} },
      },
      agentInfo: { name: "paperclip-acp-isolation-fixture", version: "1.0.0" },
    };
  }

  if (request.method === "session/new") {
    const sessionId = randomUUID();
    const inspected = await Promise.all(
      (request.params?.mcpServers ?? []).map(inspectStdioServer),
    );
    sessions.set(sessionId, inspected);
    return { sessionId };
  }

  if (request.method === "session/prompt") {
    const sessionId = request.params.sessionId;
    const observations = (sessions.get(sessionId) ?? []).map((entry) => entry.observation);
    writeMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify(observations) },
        },
      },
    });
    return { stopReason: "end_turn" };
  }

  if (request.method === "session/close") {
    const inspected = sessions.get(request.params.sessionId) ?? [];
    sessions.delete(request.params.sessionId);
    for (const entry of inspected) entry.child.kill("SIGTERM");
    return {};
  }

  if (request.method === "session/cancel") return null;
  if (request.method === "session/set_mode" || request.method === "session/set_config_option") {
    return {};
  }

  throw new Error(`Unsupported ACP method: ${request.method}`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const result = await handleRequest(request);
    if (request.id !== undefined && result !== null) {
      writeMessage({ jsonrpc: "2.0", id: request.id, result });
    }
  } catch (error) {
    if (request?.id !== undefined) {
      writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: String(error?.message ?? error) },
      });
    }
  }
});

function cleanup() {
  for (const child of childProcesses) child.kill("SIGTERM");
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let sessionId = "fixture-session";
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    writeMessage({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } }, agentInfo: { name: "paperclip-acp-child-leak-agent", version: "1.0.0" } } });
    return;
  }
  if (request.method === "session/new") {
    sessionId = "fixture-session";
    writeMessage({ jsonrpc: "2.0", id: request.id, result: { sessionId } });
    return;
  }
  if (request.method === "session/prompt") {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
    child.once("exit", () => {});
    child.unref();
    writeMessage({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: String(child.pid) } } } });
    writeMessage({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (request.method === "session/close" || request.method === "session/set_mode" || request.method === "session/set_config_option") {
    if (request.id !== undefined) writeMessage({ jsonrpc: "2.0", id: request.id, result: {} });
    return;
  }
  if (request.id !== undefined) writeMessage({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unsupported method: ${request.method}` } });
});

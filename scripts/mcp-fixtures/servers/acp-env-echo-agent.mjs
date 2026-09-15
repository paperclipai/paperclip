#!/usr/bin/env node
// Minimal ACP agent for the session-record credential regression test.
//
// It advertises `loadSession` so acpx can resume a persistent session against
// it, and answers every prompt with a fingerprint of the environment variables
// it was launched with. The fingerprint is a SHA-256 hex digest, never the
// value: the test needs to prove the credential reached the provider child on a
// resume, and a test that echoed the literal value would put a secret-shaped
// string into CI output.
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const sessions = new Set();

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fingerprintEnv() {
  const names = (process.env.PAPERCLIP_ENV_ECHO_NAMES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const digests = {};
  for (const name of names) {
    const value = process.env[name];
    digests[name] = typeof value === "string"
      ? createHash("sha256").update(value).digest("hex")
      : null;
  }
  return { pid: process.pid, digests };
}

async function handleRequest(request) {
  if (request.method === "initialize") {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { close: {} },
      },
      agentInfo: { name: "paperclip-acp-env-echo-fixture", version: "1.0.0" },
    };
  }

  if (request.method === "session/new") {
    const sessionId = randomUUID();
    sessions.add(sessionId);
    return { sessionId };
  }

  if (request.method === "session/load") {
    sessions.add(request.params.sessionId);
    return {};
  }

  if (request.method === "session/prompt") {
    writeMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify(fingerprintEnv()) },
        },
      },
    });
    return { stopReason: "end_turn" };
  }

  if (request.method === "session/close") {
    sessions.delete(request.params.sessionId);
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

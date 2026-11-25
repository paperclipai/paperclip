#!/usr/bin/env node
// A minimal ACP agent fixture that reports, on its stderr, the working
// directory the host actually spawned it in (`process.cwd()`) and the `cwd`
// advertised on the `session/new` request. Used by the remote-lane host-spawn
// smoke test to prove the `spawnCwd` decoupling: the host `spawn()` chdir is
// redirected to a host-valid dir while the advertised session cwd is unchanged.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// Emit the real spawn cwd as early as possible so a consumer capturing stderr
// sees it even if the session never advances past initialize.
process.stderr.write(`SPAWN_CWD=${process.cwd()}\n`);

async function handleRequest(request) {
  if (request.method === "initialize") {
    process.stderr.write("paperclip-acp-cwd-report-agent started\n");
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
      agentInfo: { name: "paperclip-acp-cwd-report-agent", version: "1.0.0" },
    };
  }
  if (request.method === "session/new") {
    process.stderr.write(`SESSION_NEW_CWD=${request.params?.cwd ?? ""}\n`);
    return { sessionId: randomUUID() };
  }
  if (request.method === "session/prompt") {
    writeMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
      },
    });
    return { stopReason: "end_turn" };
  }
  if (request.method === "session/close" || request.method === "session/set_mode" || request.method === "session/set_config_option") return {};
  if (request.method === "session/cancel") return null;
  throw new Error(`Unsupported ACP method: ${request.method}`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const result = await handleRequest(request);
    if (request.id !== undefined && result !== null) writeMessage({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    if (request?.id !== undefined) {
      writeMessage({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: String(error?.message ?? error) } });
    }
  }
});

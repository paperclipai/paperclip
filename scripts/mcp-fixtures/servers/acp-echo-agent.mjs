#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let supportsTypedSessionFailure = false;

async function handleRequest(request) {
  if (request.method === "initialize") {
    const air = request.params?.clientCapabilities?._meta?.jetbrains?.air;
    supportsTypedSessionFailure =
      Number.isInteger(air?.version) &&
      air.version >= 1 &&
      Array.isArray(air?.capabilities) &&
      air.capabilities.includes("sessionFailure");
    process.stderr.write(
      "Error handling request { method: 'nes/close' } { code: -32601 }\n",
    );
    process.stderr.write("paperclip-acp-echo-agent started\n");
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { close: {} },
      },
      agentInfo: { name: "paperclip-acp-echo-agent", version: "1.0.0" },
    };
  }
  if (request.method === "session/new") return { sessionId: randomUUID() };
  if (request.method === "session/prompt") {
    const typedFailureCanary = process.env.PAPERCLIP_ACPX_TYPED_FAILURE_CANARY;
    if (typedFailureCanary) {
      if (!supportsTypedSessionFailure) {
        throw new Error(
          "client did not advertise typed session-failure support",
        );
      }
      const sessionFailure = {
        id: `${request.params.sessionId}:error`,
        revision: 1,
        category: "request",
        severity: "error",
        title: typedFailureCanary,
        actions: [],
      };
      writeMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            _meta: { jetbrains: { air: { version: 1, sessionFailure } } },
          },
        },
      });
      return {
        stopReason: "end_turn",
        _meta: { jetbrains: { air: { version: 1, sessionFailure } } },
      };
    }
    const typedWarningCanary = process.env.PAPERCLIP_ACPX_TYPED_WARNING_CANARY;
    let responseMeta;
    if (typedWarningCanary) {
      if (!supportsTypedSessionFailure) {
        throw new Error(
          "client did not advertise typed session-failure support",
        );
      }
      const sessionFailure = {
        id: `${request.params.sessionId}:warning`,
        revision: 1,
        category: "connection",
        severity: "warning",
        title: typedWarningCanary,
        actions: [],
      };
      responseMeta = { jetbrains: { air: { version: 1, sessionFailure } } };
      writeMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: { sessionUpdate: "session_info_update", _meta: responseMeta },
        },
      });
    }
    writeMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: process.env.PAPERCLIP_ACPX_SPAWN_SMOKE ?? "missing",
          },
        },
      },
    });
    return {
      stopReason: "end_turn",
      ...(responseMeta ? { _meta: responseMeta } : {}),
    };
  }
  if (
    request.method === "session/close" ||
    request.method === "session/set_mode" ||
    request.method === "session/set_config_option"
  )
    return {};
  if (request.method === "session/cancel") return null;
  throw new Error(`Unsupported ACP method: ${request.method}`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const result = await handleRequest(request);
    if (request.id !== undefined && result !== null)
      writeMessage({ jsonrpc: "2.0", id: request.id, result });
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

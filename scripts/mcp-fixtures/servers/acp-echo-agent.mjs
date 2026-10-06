#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let supportsTypedSessionFailure = false;
// Claude Code reads its credentials (often an `env` block with
// ANTHROPIC_AUTH_TOKEN) from user settings. With
// PAPERCLIP_ACPX_REQUIRE_USER_SETTINGS=1 this fixture behaves like the CLI
// when `session/new` excludes the "user" setting source (#14093).
const settingSourcesBySession = new Map();

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
  if (request.method === "session/new") {
    const sessionId = randomUUID();
    settingSourcesBySession.set(sessionId, request.params?._meta?.claudeCode?.options?.settingSources);
    return { sessionId };
  }
  if (request.method === "session/prompt") {
    const settingSources = settingSourcesBySession.get(request.params.sessionId);
    if (
      process.env.PAPERCLIP_ACPX_REQUIRE_USER_SETTINGS === "1" &&
      Array.isArray(settingSources) &&
      !settingSources.includes("user")
    ) {
      const sessionFailure = {
        id: `${request.params.sessionId}:auth`,
        revision: 1,
        category: "access",
        severity: "error",
        title: "Not logged in \u00b7 Please run /login",
        actions: [],
      };
      return {
        stopReason: "end_turn",
        _meta: { jetbrains: { air: { version: 1, sessionFailure } } },
      };
    }
    const command = process.env.PAPERCLIP_ACPX_RUN_COMMAND;
    if (command) {
      const toolCallId = randomUUID();
      const update = (body) =>
        writeMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: request.params.sessionId, update: body },
        });
      update({ sessionUpdate: "tool_call", toolCallId, title: command, kind: "execute", status: "in_progress", rawInput: { command } });
      const stdout = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }).trim();
      update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput: stdout });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: stdout } });
      return { stopReason: "end_turn" };
    }
    const typedFailure = process.env.PAPERCLIP_ACPX_TYPED_FAILURE_FILE
      ? JSON.parse(await readFile(process.env.PAPERCLIP_ACPX_TYPED_FAILURE_FILE, "utf8"))
      : {};
    const typedFailureCanary = typedFailure.title ?? process.env.PAPERCLIP_ACPX_TYPED_FAILURE_CANARY;
    if (typedFailureCanary) {
      if (!supportsTypedSessionFailure) {
        throw new Error(
          "client did not advertise typed session-failure support",
        );
      }
      const sessionFailure = {
        id: `${request.params.sessionId}:error`,
        revision: 1,
        category: typedFailure.category ?? process.env.PAPERCLIP_ACPX_TYPED_FAILURE_CATEGORY ?? "request",
        severity: "error",
        title: typedFailureCanary,
        ...(typedFailure.details
          ? { details: typedFailure.details }
          : {}),
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

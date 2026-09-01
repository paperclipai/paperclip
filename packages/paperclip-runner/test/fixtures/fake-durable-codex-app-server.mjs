#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.argv[2];
if (!statePath) throw new Error("state path is required");

function load() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      threadId: "thread-durable-runnerd",
      sessionId: "session-durable-runnerd",
      nextTurn: 0,
      heldOnce: false,
      turns: {},
    };
  }
}

let state = load();
const pendingTools = new Map();
let buffer = "";

function save() {
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function finishTurn(turnId, toolResult) {
  send({
    method: "item/completed",
    params: {
      threadId: state.threadId,
      turnId,
      item: { id: `message-${turnId}`, type: "agentMessage", text: `Tool result: ${JSON.stringify(toolResult)}` },
    },
  });
  state.turns[turnId] = "completed";
  save();
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: state.threadId,
      turnId,
      tokenUsage: {
        total: {
          inputTokens: state.nextTurn * 10,
          cachedInputTokens: 0,
          outputTokens: state.nextTurn * 2,
          reasoningOutputTokens: 0,
        },
      },
    },
  });
  send({
    method: "turn/completed",
    params: { threadId: state.threadId, turn: { id: turnId, status: "completed" } },
  });
}

function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    send({ id, result: { user: { sessionId: state.sessionId } } });
    return;
  }
  if (method === "thread/start") {
    save();
    send({
      id,
      result: {
        model: "gpt-fixture",
        modelProvider: "openai-fixture",
        thread: { id: state.threadId, sessionId: state.sessionId },
      },
    });
    return;
  }
  if (method === "thread/read") {
    send({
      id,
      result: {
        thread: {
          id: state.threadId,
          sessionId: state.sessionId,
          turns: Object.entries(state.turns).map(([turnId, status]) => ({ id: turnId, status })),
          tokenUsage: {
            total: {
              inputTokens: state.nextTurn * 10,
              cachedInputTokens: 0,
              outputTokens: state.nextTurn * 2,
              reasoningOutputTokens: 0,
            },
          },
        },
      },
    });
    return;
  }
  if (method === "thread/resume") {
    send({
      id,
      result: {
        model: "gpt-fixture",
        modelProvider: "openai-fixture",
        thread: { id: state.threadId, sessionId: state.sessionId },
      },
    });
    return;
  }
  if (method === "turn/start") {
    const turnId = `turn-${++state.nextTurn}`;
    state.turns[turnId] = "inProgress";
    if (!state.heldOnce) {
      // Persist which provider turn is intentionally held before exposing its
      // tool call. If runnerd is killed immediately after delivering the tool
      // result, a replacement provider must not accidentally hold the next
      // turn as though the first response had never reached this process.
      state.heldOnce = true;
      state.heldTurnId = turnId;
    }
    save();
    send({ id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({
      method: "turn/started",
      params: { threadId: state.threadId, turn: { id: turnId, status: "inProgress" } },
    });
    const toolRequestId = `tool-${turnId}`;
    pendingTools.set(toolRequestId, turnId);
    send({
      id: toolRequestId,
      method: "item/tool/call",
      params: {
        threadId: state.threadId,
        turnId,
        callId: `governed-idempotent-call-${turnId}`,
        tool: "report_progress",
        arguments: {
          idempotencyKey: "governed-idempotency-key",
          body: "One durable governed effect.",
        },
      },
    });
    return;
  }
  if (method === "turn/interrupt") {
    const turnId = String(params.turnId);
    state.turns[turnId] = "interrupted";
    save();
    send({ id, result: {} });
    send({
      method: "turn/completed",
      params: { threadId: state.threadId, turn: { id: turnId, status: "interrupted" } },
    });
    return;
  }
  send({ id, error: { code: -32601, message: `unsupported method ${method}` } });
}

function handle(message) {
  if (message.method) {
    if (message.id !== undefined) handleRequest(message);
    return;
  }
  const turnId = pendingTools.get(String(message.id));
  if (!turnId) return;
  pendingTools.delete(String(message.id));
  if (state.heldTurnId === turnId) {
    state.heldTurnId = null;
    save();
    return;
  }
  finishTurn(turnId, message.result);
}

process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      handle(JSON.parse(line));
    }
  }
});

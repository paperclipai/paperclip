#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function serverFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const extended = body.length < 126 ? 0 : body.length <= 0xffff ? 2 : 8;
  const frame = Buffer.alloc(2 + extended + body.length);
  frame[0] = 0x80 | opcode;
  frame[1] = body.length < 126 ? body.length : extended === 2 ? 126 : 127;
  let offset = 2;
  if (extended === 2) {
    frame.writeUInt16BE(body.length, offset);
    offset += 2;
  } else if (extended === 8) {
    frame.writeBigUInt64BE(BigInt(body.length), offset);
    offset += 8;
  }
  body.copy(frame, offset);
  return frame;
}

const [mode, socketPath, statePath] = process.argv.slice(2);
if (!mode || !socketPath) throw new Error("mode and socket path are required");

if (mode === "proxy") {
  const socket = createConnection(socketPath);
  socket.once("connect", () => {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.once("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
} else if (mode === "server") {
  if (!statePath) throw new Error("state path is required in server mode");

  function load() {
    try {
      return JSON.parse(readFileSync(statePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return {
        threadId: "thread-native-resume",
        sessionId: "session-native-resume",
        turnId: "turn-native-resume",
        pendingTool: null,
        completed: false,
      };
    }
  }

  let state = load();

  function save() {
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  }

  function send(socket, value) {
    socket.write(serverFrame(JSON.stringify(value)));
  }

  function sendPendingTool(socket) {
    if (!state.pendingTool) return;
    send(socket, {
      id: state.pendingTool.requestId,
      method: "item/tool/call",
      params: {
        threadId: state.threadId,
        turnId: state.turnId,
        callId: state.pendingTool.callId,
        tool: "report_progress",
        arguments: {
          idempotencyKey: "native-resume-progress",
          body: "One native resume effect.",
        },
      },
    });
  }

  function handleRequest(socket, message) {
    const { id, method } = message;
    if (method === "initialize") {
      send(socket, { id, result: { user: { sessionId: state.sessionId } } });
      return;
    }
    if (method === "thread/start" || method === "thread/resume") {
      send(socket, {
        id,
        result: {
          model: "gpt-native-resume-fixture",
          modelProvider: "openai-fixture",
          thread: { id: state.threadId, sessionId: state.sessionId },
        },
      });
      if (method === "thread/resume") sendPendingTool(socket);
      return;
    }
    if (method === "thread/read") {
      send(socket, {
        id,
        result: {
          thread: {
            id: state.threadId,
            sessionId: state.sessionId,
            turns: [{
              id: state.turnId,
              status: state.completed ? "completed" : "inProgress",
            }],
            tokenUsage: {
              total: {
                inputTokens: 10,
                cachedInputTokens: 0,
                outputTokens: 2,
                reasoningOutputTokens: 0,
              },
            },
          },
        },
      });
      return;
    }
    if (method === "turn/start") {
      state.pendingTool = {
        requestId: "rpc-native-resume",
        callId: "call-native-resume",
      };
      save();
      send(socket, {
        id,
        result: { turn: { id: state.turnId, status: "inProgress" } },
      });
      send(socket, {
        method: "turn/started",
        params: {
          threadId: state.threadId,
          turn: { id: state.turnId, status: "inProgress" },
        },
      });
      sendPendingTool(socket);
      return;
    }
    send(socket, {
      id,
      error: { code: -32601, message: `unsupported method ${method}` },
    });
  }

  function handle(socket, message) {
    if (message.method) {
      if (message.id !== undefined) handleRequest(socket, message);
      return;
    }
    if (!state.pendingTool || String(message.id) !== state.pendingTool.requestId)
      return;
    const toolResult = message.result;
    state.pendingTool = null;
    state.completed = true;
    save();
    send(socket, {
      method: "item/completed",
      params: {
        threadId: state.threadId,
        turnId: state.turnId,
        item: {
          id: "message-native-resume",
          type: "agentMessage",
          text: `Tool result: ${JSON.stringify(toolResult)}`,
        },
      },
    });
    send(socket, {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: state.threadId,
        turnId: state.turnId,
        tokenUsage: {
          total: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 2,
            reasoningTokens: 0,
          },
          runDelta: {
            requests: 1,
            inputTokens: 10,
            cacheReadTokens: 0,
            outputTokens: 2,
            reasoningTokens: 0,
            providerCostUsd: 0,
          },
        },
      },
    });
    send(socket, {
      method: "turn/completed",
      params: {
        threadId: state.threadId,
        turn: { id: state.turnId, status: "completed" },
      },
    });
  }

  try {
    unlinkSync(socketPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const server = createServer((socket) => {
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const boundary = buffer.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        const headers = buffer.subarray(0, boundary).toString("utf8");
        const key = headers.match(/^sec-websocket-key:\s*(.+)$/im)?.[1]?.trim();
        if (!key) throw new Error("WebSocket upgrade omitted Sec-WebSocket-Key");
        const accept = createHash("sha1")
          .update(`${key}${websocketGuid}`)
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        upgraded = true;
        buffer = buffer.subarray(boundary + 4);
      }

      while (buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if ((second & 0x80) === 0)
          throw new Error("WebSocket client frame was not masked");
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        offset += 4;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        buffer = buffer.subarray(offset + length);
        for (let index = 0; index < payload.length; index += 1)
          payload[index] ^= mask[index % 4];

        const opcode = first & 0x0f;
        if (opcode === 0x8) {
          socket.end(serverFrame(payload, 0x8));
          return;
        }
        if (opcode === 0x9) {
          socket.write(serverFrame(payload, 0xa));
          continue;
        }
        if (opcode !== 0x1)
          throw new Error(`unsupported WebSocket opcode ${opcode}`);
        handle(socket, JSON.parse(payload.toString("utf8")));
      }
    });
  });
  server.listen(socketPath);
  process.once("SIGTERM", () => server.close());
} else {
  throw new Error(`unsupported mode ${mode}`);
}

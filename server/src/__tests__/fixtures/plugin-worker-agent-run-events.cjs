const readline = require("node:readline");

let nextRequestId = 1;
const pendingNested = new Map();
// Invocation id captured from the most recent executeTool call. Used by the
// "stale" getData mode to echo an id the host has already cleared.
let lastExecuteToolInvocationId = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendNestedEmitFromAgentRun(originalRequest, { payload, echoInvocationId }) {
  const nestedId = `nested-${nextRequestId++}`;
  const nestedRequest = {
    jsonrpc: "2.0",
    id: nestedId,
    method: "events.emitFromAgentRun",
    params: {
      name: "tool-done",
      payload: payload ?? {},
    },
  };
  if (echoInvocationId) {
    nestedRequest.paperclipInvocationId = echoInvocationId;
  }
  pendingNested.set(nestedId, originalRequest.id);
  send(nestedRequest);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.id && pendingNested.has(message.id)) {
    const originalId = pendingNested.get(message.id);
    pendingNested.delete(message.id);
    if (message.error) {
      send({ jsonrpc: "2.0", id: originalId, error: message.error });
      return;
    }
    send({ jsonrpc: "2.0", id: originalId, result: { data: "emitted" } });
    return;
  }

  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        ok: true,
        supportedMethods: ["executeTool", "onEvent", "runJob", "getData"],
      },
    });
    return;
  }

  if (method === "executeTool") {
    const parameters = message.params?.parameters ?? {};
    const mode = parameters.mode || "echo";
    const currentInvocationId = message.paperclipInvocation?.id ?? null;
    lastExecuteToolInvocationId = currentInvocationId;
    if (mode === "inspect-host-fields") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          data: {
            hasAgentRunScope: Object.prototype.hasOwnProperty.call(
              message.params ?? {},
              "_agentRunScope",
            ),
          },
        },
      });
      return;
    }
    const echoInvocationId = mode === "unknown"
      ? "unknown-invocation"
      : mode === "omit"
      ? null
      : currentInvocationId;
    sendNestedEmitFromAgentRun(message, {
      payload: parameters.payload,
      echoInvocationId,
    });
    return;
  }

  if (method === "onEvent") {
    sendNestedEmitFromAgentRun(message, {
      payload: { from: "onEvent" },
      echoInvocationId: message.paperclipInvocation?.id ?? null,
    });
    return;
  }

  if (method === "runJob") {
    sendNestedEmitFromAgentRun(message, {
      payload: { from: "runJob" },
      echoInvocationId: message.paperclipInvocation?.id ?? null,
    });
    return;
  }

  if (method === "getData") {
    const params = message.params?.params ?? {};
    if (params.mode === "stale") {
      sendNestedEmitFromAgentRun(message, {
        payload: { from: "stale" },
        echoInvocationId: lastExecuteToolInvocationId,
      });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { data: null } });
    return;
  }

  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => process.exit(0));
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unhandled method: ${method}` },
  });
});

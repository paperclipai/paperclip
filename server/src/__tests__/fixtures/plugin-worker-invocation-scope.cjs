const readline = require("node:readline");

let nextRequestId = 1;
const pendingNested = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendNestedHostRequest(originalRequest, invocationId) {
  const nestedId = `nested-${nextRequestId++}`;
  const params = originalRequest.params?.params ?? {};
  const mode = params.mode;
  const requestedCompanyId = params.requestedCompanyId;
  const nestedMethod = params.nestedMethod ?? "companies.get";
  const nestedParams = nestedMethod === "state.get"
    ? {
        scopeKind: "company",
        scopeId: requestedCompanyId,
        stateKey: "probe",
      }
    : {
        companyId: requestedCompanyId,
      };
  const nestedRequest = {
    jsonrpc: "2.0",
    id: nestedId,
    method: nestedMethod,
    params: nestedParams,
  };

  if (mode === "echo") {
    nestedRequest.paperclipInvocationId = invocationId;
  } else if (mode === "unknown") {
    nestedRequest.paperclipInvocationId = "unknown-invocation";
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
      send({
        jsonrpc: "2.0",
        id: originalId,
        error: message.error,
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      id: originalId,
      result: message.result,
    });
    return;
  }

  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        ok: true,
        supportedMethods: ["getData", "performAction"],
      },
    });
    return;
  }

  if (method === "getData" || method === "performAction") {
    sendNestedHostRequest(message, message.paperclipInvocation?.id);
    return;
  }

  if (method === "shutdown") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {},
    });
    setImmediate(() => process.exit(0));
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32601,
      message: `Unhandled method: ${method}`,
    },
  });
});

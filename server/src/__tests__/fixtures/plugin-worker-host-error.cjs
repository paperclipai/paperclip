const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let pendingEnvironmentExecuteId = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        ok: true,
        supportedMethods: ["environmentExecute"],
      },
    });
    return;
  }

  if (method === "environmentExecute") {
    pendingEnvironmentExecuteId = message.id;
    send({
      jsonrpc: "2.0",
      id: "host-call-1",
      method: "secrets.write",
      params: { companyId: "company-1", name: "TOKEN", value: "secret" },
    });
    return;
  }

  if (message.id === "host-call-1") {
    send({
      jsonrpc: "2.0",
      id: pendingEnvironmentExecuteId,
      result: {
        hostErrorCode: message.error?.code,
        hostErrorMessage: message.error?.message,
      },
    });
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

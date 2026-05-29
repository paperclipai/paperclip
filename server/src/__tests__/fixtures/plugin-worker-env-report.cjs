const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

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
        supportedMethods: ["reportEnv"],
      },
    });
    return;
  }

  if (method === "reportEnv") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        companyId:
          typeof process.env.PAPERCLIP_COMPANY_ID === "string"
            ? process.env.PAPERCLIP_COMPANY_ID
            : null,
        pluginId:
          typeof process.env.PAPERCLIP_PLUGIN_ID === "string"
            ? process.env.PAPERCLIP_PLUGIN_ID
            : null,
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

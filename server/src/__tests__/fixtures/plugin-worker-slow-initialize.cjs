const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let config = {};

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    config = (message.params && message.params.config) || {};
    setTimeout(() => {
      send({ jsonrpc: "2.0", id: message.id, result: { ok: true, supportedMethods: [] } });
    }, Number(config.initializeDelayMs || 0));
    return;
  }

  if (method === "shutdown") {
    setTimeout(() => {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      setImmediate(() => process.exit(0));
    }, Number(config.shutdownDelayMs || 0));
    return;
  }

  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unhandled method: ${method}` } });
});

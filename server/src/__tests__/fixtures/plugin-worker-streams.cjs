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
      result: { ok: true, supportedMethods: ["performAction"] },
    });
    return;
  }

  if (method === "performAction") {
    const params = message.params ?? {};
    const action = params.params ?? {};
    const channel = action.channel;
    const companyId = action.streamCompanyId ?? params.companyId ?? action.targetCompanyId;
    const invocationId = message.paperclipInvocation
      ? message.paperclipInvocation.id
      : undefined;
    const mark = invocationId ? { paperclipInvocationId: invocationId } : {};
    send({ jsonrpc: "2.0", method: "streams.open", params: { channel, companyId }, ...mark });
    send({
      jsonrpc: "2.0",
      method: "streams.emit",
      params: { channel, companyId, event: action.event },
      ...mark,
    });
    send({ jsonrpc: "2.0", method: "streams.close", params: { channel, companyId }, ...mark });
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
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

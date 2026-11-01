const net = require("node:net");
const readline = require("node:readline");

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const holds = new Set((process.env.GATE_HOLD || "").split(",").filter(Boolean));
const held = { initialize: [], shutdown: [] };
const released = new Set();
if (process.env.GATE_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => {});

const control = net.createConnection(process.env.GATE_SOCKET);
const report = (event) => control.write(`${JSON.stringify({ event, pid: process.pid })}\n`);
report("spawned");
readline.createInterface({ input: control }).on("line", (line) => {
  const { release, crash } = JSON.parse(line);
  if (crash) process.exit(1);
  if (!release) return;
  released.add(release);
  for (const reply of held[release].splice(0)) reply();
});

function gate(name, reply) {
  report(`${name}-received`);
  if (!holds.has(name) || released.has(name)) reply();
  else held[name].push(reply);
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    gate("initialize", () => {
      send({ jsonrpc: "2.0", id: message.id, result: { ok: true, supportedMethods: ["getData"] } });
      report("initialize-replied");
    });
  } else if (message.method === "shutdown") {
    gate("shutdown", () => {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      report("shutdown-replied");
      process.exit(0);
    });
  } else if (message.method === "getData") {
    send({ jsonrpc: "2.0", id: message.id, result: { marker: process.env.BUNDLE_MARKER || null } });
  }
});

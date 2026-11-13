// Test fixture for acpx-provider-faults.test.ts: a stand-in for the real ACPX sidecar bundle. It
// speaks the runner frame protocol on stdio, spawns a "provider" whose arguments carry the verified
// bootstrap marker, and speaks ACP to it: the provider answers the active prompt after a cancel.
"use strict";
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const PROVIDER = `
let buffer = "";
let active = null;
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.method === "session/prompt") active = message.id;
    if (message.method === "session/cancel" && active !== null) setTimeout(() => send({ jsonrpc: "2.0", id: active, result: { stopReason: "cancelled" } }), 20);
  }
});
process.stdin.on("end", () => process.exit(0));
`;
const MARKER = 'throw new Error("ACPX provider requires verified package snapshots")';

let child = null;
let turnId = null;
const frame = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const requests = readline.createInterface({ input: process.stdin });
requests.on("line", text => {
  const request = JSON.parse(text);
  if (request.command === "turn.start") {
    turnId = request.params.turnId;
    child = spawn(process.execPath, ["--eval", PROVIDER, MARKER], { stdio: ["pipe", "pipe", "inherit"] });
    readline.createInterface({ input: child.stdout }).on("line", reply => {
      frame({ protocolVersion: 1, sequence: 1, eventType: "turn.completed", runId: "r", turnId, payload: JSON.parse(reply).result });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: request.params.input }] } })}\n`);
    frame({ protocolVersion: 1, id: request.id, ok: true, result: { turnId } });
  }
  if (request.command === "turn.cancel") {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } })}\n`);
    frame({ protocolVersion: 1, id: request.id, ok: true, result: { cancelled: true } });
  }
  if (request.command === "session.close") {
    child?.stdin.end();
    requests.close();
  }
});

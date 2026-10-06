#!/usr/bin/env node
// Credential-free ACP filesystem requests, driven through the real client.
import { createInterface } from "node:readline";

const pending = new Map();
let nextId = 100;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, params });
});

createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  let result;
  if (message.method === "initialize") {
    result = {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
      agentInfo: { name: "paperclip-acp-filesystem-fixture", version: "1.0.0" },
    };
  } else if (message.method === "session/new") {
    result = { sessionId: "filesystem-fixture" };
  } else if (message.method === "session/prompt") {
    const { operations } = JSON.parse(message.params.prompt.find((entry) => entry.type === "text").text);
    for (const { method, ...params } of operations) {
      const response = await request(method, { sessionId: "filesystem-fixture", ...params });
      process.stderr.write(`FS_RESULT ${JSON.stringify(response)}\n`);
    }
    result = { stopReason: "end_turn" };
  } else if (message.method === "session/cancel") {
    return;
  } else {
    result = {};
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result });
});

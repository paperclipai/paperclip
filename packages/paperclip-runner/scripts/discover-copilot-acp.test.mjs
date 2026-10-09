import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createDiscoveryRpc, validateDiscoveryModel, withDiscoveryWorkspace } from "./discover-copilot-acp.mjs";

test("exact model evidence rejects auto before any provider operation", () => {
  for (const model of ["auto", "AUTO", " auto ", ""]) assert.throws(() => validateDiscoveryModel(model), /exact model ID/);
  validateDiscoveryModel("gpt-5.6-luna"); validateDiscoveryModel(undefined);
});
test("workspace failure always releases the acquired native command lease", async () => {
  const closed = [], removed = [];
  const install = { openCommand: async () => ({ close: async () => closed.push(true) }) };
  await assert.rejects(withDiscoveryWorkspace(install, () => assert.fail(), { mkdtemp: async () => { throw new Error("mkdir_failed"); }, rm: async (...args) => removed.push(args) }), /mkdir_failed/);
  assert.equal(closed.length, 1); assert.equal(removed.length, 0);
  await assert.rejects(withDiscoveryWorkspace(install, async () => { throw new Error("config_write_failed"); }, { mkdtemp: async () => "/fixture/private", rm: async (...args) => removed.push(args) }), /config_write_failed/);
  assert.equal(closed.length, 2); assert.deepEqual(removed, [["/fixture/private", { recursive: true, force: true }]]);
});
function childFixture() {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.written = []; child.stdin.write = value => child.written.push(JSON.parse(value)); child.killed = [];
  child.kill = signal => child.killed.push(signal); return child;
}
test("provider exit rejects pending discovery immediately with its actual failure", async () => {
  const child = childFixture(), rpc = createDiscoveryRpc(child);
  const pending = rpc.request("initialize", {}); child.emit("close", 1, null);
  await assert.rejects(pending, /provider_exited/);
  await assert.rejects(rpc.request("session/new", {}), /provider_exited/);
});
test("malformed provider output rejects pending requests instead of waiting for timeout", async () => {
  const child = childFixture(), rpc = createDiscoveryRpc(child);
  const pending = rpc.request("initialize", {}); child.stdout.emit("data", Buffer.from("not-json\n"));
  await assert.rejects(pending, /provider_malformed_json/); assert.deepEqual(child.killed, ["SIGTERM"]);
});
test("closed discovery protocol preserves numeric zero and rejects prompts", async () => {
  const child = childFixture(), rpc = createDiscoveryRpc(child);
  const pending = rpc.request("initialize", {}); assert.equal(child.written[0].id, 0);
  child.stdout.emit("data", Buffer.from('{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1}}\n'));
  assert.deepEqual(await pending, { protocolVersion: 1 });
  assert.throws(() => rpc.request("session/prompt", {}), /cannot send/); rpc.close();
});

test("discovery preserves multibyte model names when every byte arrives separately", async () => {
  const child = childFixture(), rpc = createDiscoveryRpc(child);
  const result = { models: { availableModels: [{ modelId: "gpt-5.6-luna", name: "東京 🚀 café" }] } };
  const pending = rpc.request("session/new", {});
  const wire = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 0, result })}\n`);
  for (const byte of wire) child.stdout.emit("data", Buffer.from([byte]));
  assert.deepEqual(await pending, result); rpc.close();
});

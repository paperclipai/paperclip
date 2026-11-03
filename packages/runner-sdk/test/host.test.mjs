import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { HARNESS_PROTOCOL_SCHEMA, serializeHarnessFrame } from "../dist/index.js";
import { serveHarness } from "../dist/host.js";

const identity = { harnessId: "example.fixture/native", packageName: "@example/plugin-native", version: "1.0.0",
  integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, protocolVersion: 1, runtimeDigest: `sha256:${"a".repeat(64)}` };

function fixture(overrides = {}, options = {}) {
  const input = new PassThrough(), output = new PassThrough();
  const frames = [], waiters = new Map();
  let buffer = "", requestId = 0, closed = 0;
  output.on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const frame = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      frames.push(frame);
      if (frame.id) { waiters.get(frame.id)?.(frame); waiters.delete(frame.id); }
    }
  });
  const done = serveHarness({ identity, capabilities: { interruption: true },
    execute: async () => ({ admitted: true }), snapshot: async () => ({ nativeSessionId: "native_1" }),
    close: async () => { closed += 1; return {}; }, ...overrides,
  }, { input, output, diagnostic: () => {}, ...options });
  // Attach a rejection observer immediately, while retaining the original for assertions.
  void done.catch(() => {});
  const request = (method, params = {}) => new Promise(resolve => {
    const id = ++requestId;
    waiters.set(id, resolve);
    input.write(serializeHarnessFrame({ schema: HARNESS_PROTOCOL_SCHEMA, id, method, params }));
  });
  const execute = type => request("execute", { command: { schema: "paperclip.prp.command.v1",
    commandId: `command_${requestId + 1}`, controllerSeq: requestId + 1, type,
    issuedAt: "2026-11-03T00:00:00Z", payload: {} } });
  return { input, output, frames, request, execute, done, closed: () => closed };
}

test("handshake binds the admitted release and host assigns ordered provider events", async () => {
  const f = fixture({ execute: async (_command, ctx) => {
    await ctx.emit({ eventType: "turn.started", priority: "p0", payload: {} });
    await ctx.emit({ eventType: "turn.completed", priority: "p0", payload: {} });
    return { turnId: "turn_1" };
  } });
  const hello = await f.request("initialize", { identity });
  assert.equal(hello.ok, true);
  assert.deepEqual(hello.result.identity, identity);
  assert.deepEqual(hello.result.capabilities, { interruption: true });
  const started = await f.execute("turn.start");
  assert.equal(started.result.turnId, "turn_1");
  assert.deepEqual(f.frames.filter(frame => frame.sequence).map(frame => frame.sequence), [1, 2]);
  assert.deepEqual((await f.request("snapshot")).result, { nativeSessionId: "native_1" });
  assert.equal((await f.request("close", { reason: "test" })).ok, true);
  f.input.end(); await f.done;
  assert.equal(f.closed(), 1, "explicit close and EOF share cleanup");
});

test("rejected provider facts do not consume a wire sequence", async () => {
  const f = fixture({ execute: async (_command, ctx) => {
    await assert.rejects(ctx.emit({ eventType: "item.completed", priority: "p0",
      payload: { item: { type: "toolResult", id: undefined } } }));
    await ctx.emit({ eventType: "harness.diagnostic", priority: "p0", payload: { message: "invalid provider fact rejected" } });
    await ctx.emit({ eventType: "turn.completed", priority: "p0", payload: {} });
    return {};
  } });
  await f.request("initialize", { identity });
  assert.equal((await f.execute("turn.start")).ok, true);
  assert.deepEqual(f.frames.filter(frame => frame.sequence).map(frame => frame.sequence), [1, 2]);
  f.input.end(); await f.done;
});

test("Stop bypasses a pending command, revokes late events, and callback replies do not deadlock", async () => {
  let activeSignal, lateEmit;
  let release;
  const started = new Promise(resolve => { release = resolve; });
  const f = fixture({ execute: async (command, ctx) => {
    if (command.type === "turn.start") {
      activeSignal = ctx.signal; lateEmit = ctx.emit;
      release();
      await once(ctx.signal, "abort");
      return { cancelled: true };
    }
    return { acknowledged: command.type };
  } });
  await f.request("initialize", { identity });
  const pending = f.execute("turn.start"); await started;
  assert.equal((await f.execute("semantic_tool.result")).ok, true);
  assert.equal((await f.execute("turn.stop")).ok, true);
  assert.equal(activeSignal.aborted, true);
  await assert.rejects(lateEmit({ eventType: "turn.completed", priority: "p0", payload: {} }), /cancelled/);
  assert.equal((await pending).ok, true);
  f.input.end(); await f.done;
});

test("uninitialized work and mismatched identities cannot start provider execution", async () => {
  let executions = 0;
  const f = fixture({ execute: async () => { executions += 1; return {}; } });
  assert.equal((await f.execute("turn.start")).error.code, "harness_not_initialized");
  f.input.write(serializeHarnessFrame({ schema: HARNESS_PROTOCOL_SCHEMA, id: 2, method: "initialize",
    params: { identity: { ...identity, version: "2.0.0" } } }));
  f.input.end();
  await assert.rejects(f.done, /identity does not match/);
  assert.equal(executions, 0);
  assert.equal(f.closed(), 1);
});

test("acknowledged background work keeps its signal until Stop and drain preserves admission", async () => {
  let background;
  const f = fixture({ execute: async (command, ctx) => {
    if (command.type === "turn.start") background = ctx;
    return { admitted: true };
  } });
  await f.request("initialize", { identity });
  await f.execute("turn.start");
  await f.execute("runner.drain");
  assert.equal(background.signal.aborted, false);
  await background.emit({ eventType: "item.delta", priority: "p1", payload: { text: "admitted" } });
  await f.execute("turn.stop");
  assert.equal(background.signal.aborted, true);
  await assert.rejects(background.emit({ eventType: "turn.completed", priority: "p0", payload: {} }), /cancelled/);
  f.input.end(); await f.done;
});

test("malformed and truncated input fail closed and still drain the native runtime", async () => {
  for (const bytes of [Buffer.from('{"invalid":true}\n'), Buffer.from("{}"), Buffer.from([0xff, 10])]) {
    const f = fixture(); f.input.end(bytes);
    await assert.rejects(f.done);
    assert.equal(f.closed(), 1);
  }
});

test("EOF aborts pending work and bounds cleanup even when provider teardown hangs", async () => {
  const f = fixture({ close: async () => new Promise(() => {}) }, { shutdownTimeoutMs: 15 });
  await f.request("initialize", { identity });
  f.input.end();
  await assert.rejects(f.done, /cleanup exceeded/);
});

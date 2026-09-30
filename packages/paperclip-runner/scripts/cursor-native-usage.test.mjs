import assert from "node:assert/strict";
import { test } from "node:test";
import { createCursorNativeUsage } from "./cursor-native-usage.mjs";

const id = "00000000-0000-0000-0000-000000000001";
const event = counters => ({ message: { case: "turnEnded", value: counters } });
test("observes numeric counters without accounting, totals, or invented fields", () => {
  const usage = createCursorNativeUsage(id), invocation = usage.beginParent();
  invocation.observe(event({ inputTokens: 100n, outputTokens: 3, reasoningTokens: 2n, cost: 9, text: "private" }));
  invocation.end();
  const result = usage.finish();
  assert.equal(result.completeness, "partial");
  assert.ok(result.reasons.includes("native_counter_semantics_unverified"));
  assert.deepEqual(result.observations[0].counters, { inputTokens: 100, outputTokens: 3, reasoningTokens: 2 });
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.equal(result.usage, undefined);
});
test("all native fields including explicit zeros still remain semantically unverified", () => {
  const usage = createCursorNativeUsage(id);
  usage.beginParent().observe(event({ inputTokens: 0n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }));
  assert.equal(usage.finish().completeness, "partial");
  assert.deepEqual(usage.finish().reasons, ["native_counter_semantics_unverified"]);
});
test("rejects invalid identity and omits invalid counters", () => {
  assert.throws(() => createCursorNativeUsage("private arbitrary text"));
  for (const value of [-1, 1.2, NaN, Infinity, null, "20", {}, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
    const usage = createCursorNativeUsage(id);
    usage.beginParent().observe(event({ inputTokens: value, outputTokens: 1 }));
    const result = usage.finish();
    assert.deepEqual(result.observations[0].counters, { outputTokens: 1 });
    assert.ok(result.reasons.includes("invalid_native_counter"));
  }
});
test("separate native invocations retain repeated snapshots without adding or deduplicating counts", () => {
  const usage = createCursorNativeUsage(id), first = usage.beginParent();
  first.observe(event({ inputTokens: 4 })); first.observe(event({ inputTokens: 4 })); first.end();
  first.observe(event({ inputTokens: 999 }));
  usage.beginParent().observe(event({ inputTokens: 2 }));
  const result = usage.finish();
  assert.deepEqual(result.observations.map(row => row.counters.inputTokens), [4, 4, 2]);
  assert.deepEqual(result.observations.map(row => row.invocationId), ["invocation-1", "invocation-1", "invocation-2"]);
  assert.ok(result.reasons.includes("multiple_terminal_observations"));
});
test("history, late callbacks, closed prompts and reused child runs stay isolated", () => {
  const usage = createCursorNativeUsage(id), child = { runs: 1, terminal: false };
  const first = usage.beginParent();
  first.observe({ message: { case: "tokenDelta", value: { tokens: 100 } } });
  usage.observeChild(child, event({ outputTokens: 5 }));
  child.runs = 2; usage.observeChild(child, event({ outputTokens: 6 }));
  child.terminal = true; usage.observeChild(child, event({ outputTokens: 999 }));
  const result = usage.finish();
  first.observe(event({ outputTokens: 999 })); child.terminal = false; usage.observeChild(child, event({ outputTokens: 999 }));
  assert.deepEqual(result.observations.map(row => [row.role, row.nativeRun, row.counters.outputTokens]), [["child", 1, 5]]);
  assert.ok(result.reasons.includes("child_run_attribution_unverified"));
  assert.deepEqual(usage.finish(), result);
  assert.equal(usage.beginParent(), null);
  assert.deepEqual(createCursorNativeUsage(id).finish().observations, []);
});
test("bounds observation count, invocation count, and UTF-8 envelope bytes", () => {
  const usage = createCursorNativeUsage(id);
  for (let i = 0; i < 1000; i++) {
    const invocation = usage.beginParent();
    for (let j = 0; j < 3; j++) invocation?.observe(event(Object.fromEntries(
      ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"].map(k => [k, Number.MAX_SAFE_INTEGER]))));
  }
  const result = usage.finish();
  assert.ok(result.observations.length <= 64);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 15744);
  assert.equal(result.truncated, true);
  assert.ok(result.reasons.includes("observation_limit_reached"));
});
test("finish finalizes missing children and open parents even when another invocation reported", () => {
  for (const missing of ["child", "parent"]) {
    const usage = createCursorNativeUsage(id);
    usage.beginParent().observe(event({ inputTokens: 1 }));
    if (missing === "child") usage.observeChild({ runs: 1, terminal: false }, { message: { case: "textDelta" } });
    else usage.beginParent();
    const result = usage.finish();
    assert.ok(result.reasons.includes("native_terminal_not_observed"));
    assert.equal(result.observations.length, 1);
    assert.deepEqual(usage.finish(), result);
    result.reasons.length = 0;
    assert.ok(usage.finish().reasons.includes("native_terminal_not_observed"));
  }
});
test("final reason growth cannot exceed the envelope byte cap", () => {
  let trimmed = false;
  for (let count = 48; count <= 64; count++) {
    const usage = createCursorNativeUsage(id), parent = usage.beginParent();
    for (let i = 0; i < count; i++) parent.observe(event(Object.fromEntries(
      ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"].map(k => [k, Number.MAX_SAFE_INTEGER]))));
    usage.observeChild({ runs: 1, terminal: false }, { message: { case: "textDelta" } });
    usage.observeChild({ runs: 2, terminal: false }, event({ inputTokens: 1 }));
    const result = usage.finish();
    assert.ok(result.reasons.includes("native_terminal_not_observed"));
    assert.ok(result.reasons.includes("child_run_attribution_unverified"));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 15744);
    if (result.observations.length < count) {
      trimmed = true; assert.equal(result.truncated, true);
      assert.ok(result.reasons.includes("observation_limit_reached"));
    }
  }
  assert.equal(trimmed, true);
});

test("maximum bounded ACPX identities and envelope fit the final stored object", () => {
  const usage = createCursorNativeUsage(id), parent = usage.beginParent();
  for (let count = 0; count < 64; count++) parent.observe(event(Object.fromEntries(
    ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"].map(k => [k, Number.MAX_SAFE_INTEGER]))));
  usage.beginParent();
  const receipt = usage.finish();
  assert.equal(receipt.limits.maxBytes, 16384);
  assert.equal(receipt.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 15744);
  const stored = { request_id: "r".repeat(240), prompt_message_id: "m".repeat(240), receipt };
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) <= 16384);
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) - Buffer.byteLength(JSON.stringify(receipt)) <= 640);
});


test("missing, invalid and reused child run ordinals are explicitly partial", () => {
  for (const runs of [undefined, null, 0, -1, 1.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 2]) {
    const usage = createCursorNativeUsage(id);
    const parent = usage.beginParent(); parent.observe(event({ inputTokens: 1 }));
    usage.observeChild({ runs, terminal: false }, event({ inputTokens: 999 }));
    const receipt = usage.finish();
    assert.equal(receipt.completeness, "partial");
    assert.equal(receipt.observations.length, 1);
    assert.ok(receipt.reasons.includes("child_run_attribution_unverified"));
  }
});

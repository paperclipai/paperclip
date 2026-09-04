import assert from "node:assert/strict";
import { test } from "node:test";

import { findBareRealProcessWaits } from "./lib/bare-real-process-wait.mjs";

test("rejects a vi.waitFor( with no in-process marker on the line above", () => {
  const source = [
    "async function example() {",
    "  await vi.waitFor(() => expect(x).toBe(1));",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), [
    { line: 2, pattern: "vi.waitFor(" },
  ]);
});

test("allows a vi.waitFor( marked as settling fully in-process", () => {
  const source = [
    "async function example() {",
    "  // bare-wait-ok: settles fully in-process, no spawned OS process.",
    "  await vi.waitFor(() => expect(x).toBe(1));",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), []);
});

test("allows the named real-process wait helper instead of vi.waitFor", () => {
  const source = [
    "async function example() {",
    '  await waitForCapabilityLiveProcess("label", () => expect(x).toBe(1));',
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), []);
});

test("flags every unmarked vi.waitFor( in a file with a mix of marked and unmarked calls", () => {
  const source = [
    "async function example() {",
    "  await vi.waitFor(() => expect(a).toBe(1));",
    "  // bare-wait-ok: settles fully in-process, no spawned OS process.",
    "  await vi.waitFor(() => expect(b).toBe(2));",
    "  await vi.waitFor(() => expect(c).toBe(3));",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), [
    { line: 2, pattern: "vi.waitFor(" },
    { line: 5, pattern: "vi.waitFor(" },
  ]);
});

test("rejects a bare expect.poll( with no in-process marker on the line above", () => {
  const source = [
    "async function example() {",
    "  await expect",
    "    .poll(async () => readFile(path, 'utf8'))",
    "    .toBe('done');",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), [
    { line: 2, pattern: "expect.poll(" },
  ]);
});

test("allows an expect.poll( marked as settling fully in-process", () => {
  const source = [
    "async function example() {",
    "  // bare-wait-ok: settles fully in-process, no spawned OS process.",
    "  await expect",
    "    .poll(async () => readFile(path, 'utf8'))",
    "    .toBe('done');",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), []);
});

test("allows an expect.poll( that passes an explicit timeout option", () => {
  const source = [
    "async function example() {",
    "  await expect",
    "    .poll(async () => readFile(path, 'utf8'), { timeout: 10_000 })",
    "    .toBe('done');",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), []);
});

test("rejects a vi.waitFor( whose callback body passes an unrelated timeout option", () => {
  const source = [
    "async function example() {",
    "  await vi.waitFor(() => invoke({ timeout: 500 }));",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), [
    { line: 2, pattern: "vi.waitFor(" },
  ]);
});

test("allows a vi.waitFor( whose own second argument passes a timeout option, even with a same-shaped callback option", () => {
  const source = [
    "async function example() {",
    "  await vi.waitFor(() => invoke({ timeout: 500 }), { timeout: 10_000 });",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), []);
});

test("ignores a vi.waitFor( written inside a line comment", () => {
  const source = [
    "async function example() {",
    "  // do not call vi.waitFor( here, it is not spawned-process bound",
    "  await Promise.resolve();",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), []);
});

test("ignores an expect.poll( written inside a block comment", () => {
  const source = [
    "async function example() {",
    "  /* legacy note: this used to call",
    "     expect.poll( on the old transport */",
    "  await Promise.resolve();",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), []);
});

test("ignores a vi.waitFor( written inside a string literal", () => {
  const source = [
    "async function example() {",
    '  const message = "replace this call with vi.waitFor( for a live wait";',
    "  await Promise.resolve();",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), []);
});

test("ignores an expect.poll( written inside a template literal", () => {
  const source = [
    "async function example() {",
    "  const message = `see expect.poll( for the retry loop`;",
    "  await Promise.resolve();",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), []);
});

test("rejects a vi.waitFor( written inside a template literal interpolation", () => {
  const source = [
    "async function example() {",
    "  const message = `status: ${await vi.waitFor(() => expect(x).toBe(1))}`;",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), [
    { line: 2, pattern: "vi.waitFor(" },
  ]);
});

test("rejects a vi.waitFor( that follows a regex literal with a closing brace inside a template literal interpolation", () => {
  const source = [
    "async function example() {",
    "  const message = `status: ${/}/.test(x) ? await vi.waitFor(() => expect(x).toBe(1)) : false}`;",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), [
    { line: 2, pattern: "vi.waitFor(" },
  ]);
});

test("rejects a vi.waitFor( that follows a regex literal with a quantifier's opening and closing braces inside a template literal interpolation", () => {
  const source = [
    "async function example() {",
    "  const message = `status: ${/^a{2,4}$/.test(x) ? await vi.waitFor(() => expect(x).toBe(1)) : false}`;",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), [
    { line: 2, pattern: "vi.waitFor(" },
  ]);
});

test("rejects a vi.waitFor( that follows an await-prefixed regex literal with a closing brace inside a template literal interpolation", () => {
  const source = [
    "async function example() {",
    "  const message = `status: ${await /}/.test(x) ? await vi.waitFor(() => expect(x).toBe(1)) : false}`;",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), [
    { line: 2, pattern: "vi.waitFor(" },
  ]);
});

test("ignores a vi.waitFor( written inside a regex literal's own text, inside a template literal interpolation", () => {
  const source = [
    "async function example() {",
    "  const message = `status: ${/vi\\.waitFor\\(/.test(callSite) ? \"bad\" : \"ok\"}`;",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), []);
});

test("still flags a real bare vi.waitFor( on the line after a comment mentioning the pattern", () => {
  const source = [
    "async function example() {",
    "  // vi.waitFor( is normally the wrong tool here, but this one needs it:",
    "  await vi.waitFor(() => expect(x).toBe(1));",
    "}",
  ].join("\n");

  assert.deepEqual(findBareRealProcessWaits(source), [
    { line: 3, pattern: "vi.waitFor(" },
  ]);
});

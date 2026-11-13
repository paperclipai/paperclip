import assert from "node:assert/strict";
import path from "node:path";

function validateTests(tests, file) {
  assert.ok(Array.isArray(tests) && tests.length > 0, "Vitest must collect at least one test");
  for (const test of tests) {
    assert.equal(test.projectName, "@paperclipai/server", "unexpected test project");
    assert.equal(path.resolve(test.file), path.resolve(file), "unexpected test file");
    assert.ok(typeof test.name === "string" && test.name.length > 0, "missing test name");
    assert.ok(Number.isSafeInteger(test.location?.line) && test.location.line > 0, "missing test source line");
  }
}

// Keep all cases registered on one source line together, including it.each
// and loop-generated cases. Balance by collected case count, not line count.
export function partitionTestLines(tests, count, file) {
  validateTests(tests, file);
  assert.ok(Number.isSafeInteger(count) && count > 0, "invalid shard count");
  const byLine = new Map();
  for (const test of tests) {
    const line = test.location.line;
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push(test);
  }
  assert.ok(byLine.size >= count, "each shard must contain a source line");
  const groups = [...byLine].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
  const shards = Array.from({ length: count }, () => ({ lines: [], tests: [] }));
  for (const [line, cases] of groups) {
    const shard = shards.reduce((best, next) => next.tests.length < best.tests.length ? next : best);
    shard.lines.push(line);
    shard.tests.push(...cases);
  }
  for (const shard of shards) shard.lines.sort((a, b) => a - b);
  return shards;
}

// Re-collect using the exact filters passed to the subsequent test run. A
// Vitest filtering change must fail here instead of silently dropping cases.
export function assertSelectedTests(expected, actual, file) {
  validateTests(actual, file);
  const identities = (tests) => tests.map((test) => JSON.stringify([
    test.projectName, path.resolve(test.file), test.location.line, test.name,
  ])).sort();
  assert.deepEqual(identities(actual), identities(expected), "Vitest filters must select exactly the assigned tests");
}

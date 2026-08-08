import assert from "node:assert/strict";
import test from "node:test";

import { findZeroExecutedSuites } from "../check-executed-test-suites.mjs";

function suite(name, statuses) {
  return { name, assertionResults: statuses.map((status) => ({ status })) };
}

test("a suite where every test is skipped is reported as zero-executed", () => {
  const offenders = findZeroExecutedSuites({
    testResults: [suite("a.test.ts", ["skipped", "skipped", "skipped"])],
  });

  assert.deepEqual(offenders, [{ file: "a.test.ts", declaredTests: 3 }]);
});

test("a suite with at least one executed test is not reported", () => {
  const offenders = findZeroExecutedSuites({
    testResults: [suite("a.test.ts", ["skipped", "passed", "skipped"])],
  });

  assert.deepEqual(offenders, []);
});

test("a failing test counts as executed", () => {
  const offenders = findZeroExecutedSuites({
    testResults: [suite("a.test.ts", ["failed"])],
  });

  assert.deepEqual(offenders, []);
});

test("a suite that collected no tests at all is not reported", () => {
  // Empty files and collection errors are a different failure that vitest
  // already surfaces; this guard is about files that declare tests but run none.
  const offenders = findZeroExecutedSuites({ testResults: [suite("a.test.ts", [])] });

  assert.deepEqual(offenders, []);
});

test("offenders are reported per file across a mixed run", () => {
  const offenders = findZeroExecutedSuites({
    testResults: [
      suite("ran.test.ts", ["passed", "passed"]),
      suite("hidden-a.test.ts", ["skipped"]),
      suite("hidden-b.test.ts", ["skipped", "skipped"]),
    ],
  });

  assert.deepEqual(offenders, [
    { file: "hidden-a.test.ts", declaredTests: 1 },
    { file: "hidden-b.test.ts", declaredTests: 2 },
  ]);
});

test("a malformed report yields no offenders rather than throwing", () => {
  assert.deepEqual(findZeroExecutedSuites({}), []);
  assert.deepEqual(findZeroExecutedSuites(null), []);
  assert.deepEqual(findZeroExecutedSuites({ testResults: "nope" }), []);
});

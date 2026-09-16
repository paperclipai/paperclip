import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkForbiddenImports,
  defaultPackageRoot,
} from "./lib/forbidden-imports.mjs";

test("the package passes its standalone boundary", async () => {
  assert.deepEqual(await checkForbiddenImports(), []);
});

test("a negative fixture proves that a core import is rejected", async () => {
  const violations = await checkForbiddenImports({
    scanRoots: ["test-fixtures/forbidden-import"],
    cargoRoots: [],
    checkManifest: false,
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].specifier, "../../../../server/src/services/heartbeat.js");
  assert.match(violations[0].reason, /may not escape/);
  assert.ok(violations[0].file.startsWith(defaultPackageRoot));
});

test("a negative Cargo fixture proves that a core path dependency is rejected", async () => {
  const violations = await checkForbiddenImports({
    scanRoots: [],
    cargoRoots: ["test-fixtures/forbidden-cargo-path"],
    checkManifest: false,
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].specifier, "../../../../server");
  assert.match(violations[0].reason, /Cargo path dependencies may not escape/);
  assert.ok(violations[0].file.startsWith(defaultPackageRoot));
});

test("a negative fixture proves that a browser UI runtime import is rejected", async () => {
  const violations = await checkForbiddenImports({
    scanRoots: ["devtools/browser", "test-fixtures/forbidden-ui-runtime/devtools/browser"],
    cargoRoots: [],
    checkManifest: false,
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].specifier, "@ai-sdk/react");
  assert.match(violations[0].reason, /adapts component source/);
  assert.ok(violations[0].file.startsWith(defaultPackageRoot));
});

test("a negative fixture proves that an SDK consumer deep import is rejected", async () => {
  const violations = await checkForbiddenImports({
    scanRoots: ["test-fixtures/forbidden-sdk-consumer/examples"],
    cargoRoots: [],
    checkManifest: false,
  });

  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /may not deep-import/);
});

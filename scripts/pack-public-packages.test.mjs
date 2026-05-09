import assert from "node:assert/strict";
import test from "node:test";

import { applyPublishConfig } from "./pack-public-packages.mjs";

test("applyPublishConfig promotes exports/main/types from publishConfig and strips publishConfig", () => {
  const input = {
    name: "@paperclipai/server",
    version: "9.9.9-test",
    type: "module",
    exports: { ".": "./src/index.ts" },
    publishConfig: {
      access: "public",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
    },
  };

  const result = applyPublishConfig(input);

  assert.deepEqual(result.exports, {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
  });
  assert.equal(result.main, "./dist/index.js");
  assert.equal(result.types, "./dist/index.d.ts");
  assert.equal(result.publishConfig, undefined);
  // input must not be mutated
  assert.deepEqual(input.exports, { ".": "./src/index.ts" });
  assert.ok(input.publishConfig, "input still carries publishConfig");
});

test("applyPublishConfig drops registry-only directives (access/registry/tag) so they don't leak onto the manifest", () => {
  const input = {
    name: "paperclipai",
    version: "1.0.0",
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
      tag: "latest",
    },
  };

  const result = applyPublishConfig(input);

  assert.equal(result.access, undefined);
  assert.equal(result.registry, undefined);
  assert.equal(result.tag, undefined);
  assert.equal(result.publishConfig, undefined);
});

test("applyPublishConfig is a no-op when publishConfig is missing", () => {
  const input = { name: "x", version: "1.0.0", main: "./index.js" };
  const result = applyPublishConfig(input);
  assert.deepEqual(result, input);
});

test("applyPublishConfig promotes bin overrides (mcp-server pattern)", () => {
  const input = {
    name: "@paperclipai/mcp-server",
    version: "1.0.0",
    bin: { "paperclip-mcp": "./src/index.ts" },
    publishConfig: {
      bin: { "paperclip-mcp": "./dist/index.js" },
      exports: { ".": { import: "./dist/index.js" } },
    },
  };
  const result = applyPublishConfig(input);
  assert.deepEqual(result.bin, { "paperclip-mcp": "./dist/index.js" });
});

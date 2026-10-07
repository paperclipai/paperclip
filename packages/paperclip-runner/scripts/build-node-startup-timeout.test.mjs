import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildNodeStartupTimeout } from "./build-node-startup-timeout.mjs";

test("cold Rosetta Node startup has a bounded build-only allowance", () => {
  assert.equal(buildNodeStartupTimeout("darwin", "x64"), 30_000);
  for (const [platform, architecture] of [["darwin", "arm64"], ["linux", "x64"], ["linux", "arm64"], ["win32", "x64"]]) {
    assert.equal(buildNodeStartupTimeout(platform, architecture), 10_000);
  }
  assert.equal(buildNodeStartupTimeout(), buildNodeStartupTimeout(process.platform, process.arch));
});

test("the ordinary provider pack Node probe uses the bounded startup allowance", () => {
  const pack = readFileSync(new URL("./build-provider-pack.mjs", import.meta.url), "utf8");
  assert.match(pack, /spawnSync\(stableNodeCommand, \["--version"\], \{[^}]*env: \{[^}]*\}[^}]*timeout: buildNodeStartupTimeout\(\)/);
});

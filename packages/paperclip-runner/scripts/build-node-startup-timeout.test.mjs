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

test("both pack and private Pi Node probes use the allowance without changing other operation deadlines", () => {
  const pack = readFileSync(new URL("./build-provider-pack.mjs", import.meta.url), "utf8");
  const pi = readFileSync(new URL("./materialize-pi-distribution.mjs", import.meta.url), "utf8");
  assert.match(pack, /spawnSync\(stableNodeCommand, \["--version"\], \{[^}]*env: \{[^}]*\}[^}]*timeout: buildNodeStartupTimeout\(\)/);
  for (const probe of ['run(node, ["--version"]', 'run(node, ["-p", "process.versions.undici"]', 'run(copiedNode, ["--version"]']) {
    const line = pi.split("\n").find(line => line.includes(probe));
    assert.ok(line?.includes("timeout: buildNodeStartupTimeout()"), probe);
  }
  assert.match(pi, /run\("git", \["apply", "--check", patchPath\], \{[^}]*timeout: 10_000/);
  assert.match(pi, /run\("\/usr\/bin\/otool", \["-L", copiedNode\], \{ env: \{\}, timeout: 10_000/);
});

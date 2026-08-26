import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveVitestCli } from "../vitest-cli.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runnerSource = readFileSync(path.join(repoRoot, "scripts", "run-vitest-stable.mjs"), "utf8");

test("resolves an existing Vitest JS entry point", () => {
  const cli = resolveVitestCli();

  assert.ok(path.isAbsolute(cli), `expected an absolute path, got ${cli}`);
  assert.equal(path.basename(cli), "vitest.mjs");
  assert.ok(existsSync(cli), `expected ${cli} to exist`);
});

test("caches the resolved path", () => {
  assert.equal(resolveVitestCli(), resolveVitestCli());
});

test("the entry point is directly executable by Node, not a shell shim", () => {
  // A .cmd/.bat/.ps1 shim cannot be spawned without a shell on Windows, which
  // is the defect this module exists to avoid.
  const cli = resolveVitestCli();

  assert.ok(
    !/\.(cmd|bat|ps1)$/i.test(cli),
    `expected a JS entry point rather than a shell shim, got ${cli}`,
  );
});

test("the runner spawns Node with the resolved entry point and never spawns pnpm", () => {
  assert.match(
    runnerSource,
    /spawnSync\(\s*process\.execPath,\s*\[\s*resolveVitestCli\(\)/,
    "expected the runner to spawn Node with the resolved Vitest entry point",
  );
  assert.doesNotMatch(
    runnerSource,
    /spawnSync\(\s*"pnpm"/,
    "expected the runner not to spawn the pnpm shim, which fails on Windows",
  );
  assert.doesNotMatch(
    runnerSource,
    /shell:\s*true/,
    "expected the runner not to use a shell, which overruns the cmd.exe command-line limit",
  );
});

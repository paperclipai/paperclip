import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const script = new URL("../run-typecheck-build-gaps.mjs", import.meta.url).pathname;

function createFixtureRepo() {
  return mkdtempSync(path.join(tmpdir(), "run-typecheck-build-gaps-test-"));
}

function writeFixtureFile(root, relativePath, body = "fixture") {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body);
}

function runRuntimeAssetGuard(root) {
  return spawnSync(process.execPath, [script, "--runtime-assets-only"], {
    cwd: root,
    encoding: "utf8",
  });
}

test("passes when all source runtime assets are present in dist", () => {
  const root = createFixtureRepo();
  try {
    writeFixtureFile(root, "server/src/built-ins/agents/default.md");
    writeFixtureFile(root, "server/dist/built-ins/agents/default.md");
    writeFixtureFile(root, "server/src/onboarding-assets/welcome.txt");
    writeFixtureFile(root, "server/dist/onboarding-assets/welcome.txt");
    writeFixtureFile(root, "server/src/built-ins/ignored.ts");

    const result = runRuntimeAssetGuard(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /server runtime assets present in dist: 2 file\(s\)/);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails with the missing source asset and expected dist path", () => {
  const root = createFixtureRepo();
  try {
    writeFixtureFile(root, "server/src/built-ins/agents/default.md");

    const result = runRuntimeAssetGuard(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing server runtime asset\(s\) in dist/);
    assert.match(result.stderr, /source: server\/src\/built-ins\/agents\/default\.md/);
    assert.match(result.stderr, /expected dist: server\/dist\/built-ins\/agents\/default\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

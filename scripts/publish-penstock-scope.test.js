import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publishScriptPath = resolve(repoRoot, "scripts/publish-penstock-scope.mjs");
const sharedManifestPath = resolve(repoRoot, "packages/shared/package.json");
const sdkManifestPath = resolve(repoRoot, "packages/plugins/sdk/package.json");

function readJsonLines(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function createFakeNpm() {
  const dir = mkdtempSync(resolve(tmpdir(), "paperclip-fake-npm-"));
  const binDir = resolve(dir, "bin");
  const logPath = resolve(dir, "npm-publish.jsonl");
  mkdirSync(binDir, { recursive: true });
  const npmPath = resolve(binDir, "npm");
  writeFileSync(
    npmPath,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
appendFileSync(
  process.env.FAKE_NPM_LOG,
  JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), manifest }) + "\\n",
);

if (process.env.FAKE_NPM_EXIT) process.exit(Number(process.env.FAKE_NPM_EXIT));
`,
  );
  chmodSync(npmPath, 0o755);
  return { dir, binDir, logPath };
}

function createPublishFixture() {
  const dir = mkdtempSync(resolve(tmpdir(), "paperclip-penstock-publish-"));
  const fixtureScriptPath = resolve(dir, "scripts/publish-penstock-scope.mjs");
  const fixtureSharedManifestPath = resolve(dir, "packages/shared/package.json");
  const fixtureSdkManifestPath = resolve(dir, "packages/plugins/sdk/package.json");
  const originalShared = readFileSync(sharedManifestPath, "utf8");
  const originalSdk = readFileSync(sdkManifestPath, "utf8");

  mkdirSync(dirname(fixtureScriptPath), { recursive: true });
  mkdirSync(dirname(fixtureSharedManifestPath), { recursive: true });
  mkdirSync(dirname(fixtureSdkManifestPath), { recursive: true });
  copyFileSync(publishScriptPath, fixtureScriptPath);
  writeFileSync(fixtureSharedManifestPath, originalShared);
  writeFileSync(fixtureSdkManifestPath, originalSdk);

  return {
    dir,
    sharedManifestPath: fixtureSharedManifestPath,
    sdkManifestPath: fixtureSdkManifestPath,
    originalShared,
    originalSdk,
  };
}

function runPublishScript(fakeNpm, fixture, extraEnv = {}) {
  return spawnSync(process.execPath, ["scripts/publish-penstock-scope.mjs", "--version", "2026.614.0"], {
    cwd: fixture.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      FAKE_NPM_LOG: fakeNpm.logPath,
      PATH: `${fakeNpm.binDir}:${process.env.PATH}`,
    },
  });
}

test("publish-penstock-scope rewrites manifests for npm publish and restores them", () => {
  const fakeNpm = createFakeNpm();
  const fixture = createPublishFixture();

  try {
    const result = runPublishScript(fakeNpm, fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const calls = readJsonLines(fakeNpm.logPath);
    assert.equal(calls.length, 2);

    const [shared, sdk] = calls;
    assert.deepEqual(shared.argv, ["publish", "--access", "public", "--dry-run"]);
    assert.equal(shared.manifest.name, "@penstock/shared");
    assert.equal(shared.manifest.version, "2026.614.0");
    assert.equal(shared.manifest.private, undefined);
    assert.deepEqual(shared.manifest.publishConfig, { access: "public" });
    assert.equal(shared.manifest.main, "./dist/index.js");
    assert.equal(shared.manifest.types, "./dist/index.d.ts");
    assert.deepEqual(shared.manifest.exports["."], {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });

    assert.deepEqual(sdk.argv, ["publish", "--access", "public", "--dry-run"]);
    assert.equal(sdk.manifest.name, "@penstock/plugin-sdk");
    assert.equal(sdk.manifest.version, "2026.614.0");
    assert.deepEqual(sdk.manifest.publishConfig, { access: "public" });
    assert.equal(sdk.manifest.dependencies["@paperclipai/shared"], "npm:@penstock/shared@2026.614.0");
    assert.equal(sdk.manifest.dependencies["@penstock/shared"], undefined);
  } finally {
    assert.equal(readFileSync(fixture.sharedManifestPath, "utf8"), fixture.originalShared);
    assert.equal(readFileSync(fixture.sdkManifestPath, "utf8"), fixture.originalSdk);
    rmSync(fixture.dir, { recursive: true, force: true });
    rmSync(fakeNpm.dir, { recursive: true, force: true });
  }
});

test("publish-penstock-scope restores manifests when npm publish fails", () => {
  const fakeNpm = createFakeNpm();
  const fixture = createPublishFixture();

  try {
    const result = runPublishScript(fakeNpm, fixture, { FAKE_NPM_EXIT: "42" });
    assert.notEqual(result.status, 0);
    assert.equal(readJsonLines(fakeNpm.logPath).length, 1);
  } finally {
    assert.equal(readFileSync(fixture.sharedManifestPath, "utf8"), fixture.originalShared);
    assert.equal(readFileSync(fixture.sdkManifestPath, "utf8"), fixture.originalSdk);
    rmSync(fixture.dir, { recursive: true, force: true });
    rmSync(fakeNpm.dir, { recursive: true, force: true });
  }
});

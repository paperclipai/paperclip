import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../..");
const scriptPath = path.join(testDir, "grok-build-openai-compatible.mjs");

function smokeEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.XAI_API_KEY;
  return { ...env, ...overrides };
}

function runSmoke(args = [], envOverrides = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: smokeEnv(envOverrides),
    encoding: "utf8",
  });
}

test("fails with the sanitized environment blocker when XAI_API_KEY is missing", () => {
  const result = runSmoke([], {
    PAPERCLIP_TEST_SENTINEL: "do-not-print-this-value",
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^\[grok-build-openai-compatible\] fail/m);
  assert.match(
    result.stderr,
    /XAI_API_KEY is required for the Paperclip internal Grok Build smoke environment\./,
  );
  assert.doesNotMatch(output, /do-not-print-this-value/);
  assert.doesNotMatch(output, /Bearer\s+/i);
});

test("treats blank XAI_API_KEY values as missing", () => {
  const result = runSmoke([], { XAI_API_KEY: "   " });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /XAI_API_KEY is required for the Paperclip internal Grok Build smoke environment\./,
  );
});

test("prints help without requiring XAI_API_KEY", () => {
  const result = runSmoke(["--help"]);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /smoke:grok-build-openai-compatible/);
  assert.match(result.stdout, /Grok Build 0\.1/);
  assert.match(result.stdout, /https:\/\/api\.x\.ai\/v1\/chat\/completions/);
});

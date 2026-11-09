import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "e2e-update-migrations.sh");
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("PAPERCLIP_") && !name.startsWith("E2E_UPDATE_")),
);

test("cross-version migration harness has valid shell syntax", () => {
  const result = spawnSync("bash", ["-n", script], { cwd: repoRoot, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
});

test("failure cleanup removes the service and managed install", () => {
  const source = readFileSync(script, "utf8");
  const cleanup = source.match(/cleanup\(\) \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

  assert.ok(cleanup, "expected a cleanup function");
  assert.match(cleanup, /shim service stop/);
  assert.match(cleanup, /shim service uninstall/);
  assert.match(cleanup, /shim uninstall/);
});

test("cross-version migration harness requires both refs before side effects", () => {
  for (const testCase of [
    { env: {}, missing: "E2E_UPDATE_BASE_REF" },
    { env: { E2E_UPDATE_BASE_REF: "test/base" }, missing: "E2E_UPDATE_NEXT_REF" },
  ]) {
    const testHome = mkdtempSync(path.join(os.tmpdir(), "paperclip-update-migrations-"));
    try {
      const result = spawnSync("bash", [script], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...cleanEnv, HOME: testHome, ...testCase.env },
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`${testCase.missing} is required`));
      assert.deepEqual(readdirSync(testHome), [], "validation must run before the harness writes files");
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  }
});

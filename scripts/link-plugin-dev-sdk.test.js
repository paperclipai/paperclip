import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const realScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "link-plugin-dev-sdk.mjs",
);

// The script resolves the repo root and SDK directory from its own location,
// so each fixture mirrors the repo layout and gets its own copy of the script.
function makeFixture() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "link-plugin-sdk-test-"));
  const sdkDir = path.join(repoRoot, "packages", "plugins", "sdk");
  const pluginDir = path.join(repoRoot, "packages", "plugins", "test-plugin");
  const scriptPath = path.join(repoRoot, "scripts", "link-plugin-dev-sdk.mjs");
  mkdirSync(sdkDir, { recursive: true });
  mkdirSync(pluginDir, { recursive: true });
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  writeFileSync(path.join(sdkDir, "marker.txt"), "sdk marker");
  writeFileSync(path.join(pluginDir, "package.json"), "{}\n");
  copyFileSync(realScript, scriptPath);
  return {
    repoRoot,
    sdkDir,
    pluginDir,
    scriptPath,
    linkTarget: path.join(pluginDir, "node_modules", "@paperclipai", "plugin-sdk"),
    run() {
      return spawnSync(process.execPath, [scriptPath], {
        cwd: pluginDir,
        encoding: "utf8",
      });
    },
    cleanup() {
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

test("creates a link that resolves to the SDK directory", (t) => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());

  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lstatSync(fixture.linkTarget).isSymbolicLink());
  assert.equal(realpathSync(fixture.linkTarget), realpathSync(fixture.sdkDir));
  assert.equal(
    readFileSync(path.join(fixture.linkTarget, "marker.txt"), "utf8"),
    "sdk marker",
  );
});

test("re-running replaces the existing link and still resolves correctly", (t) => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());

  const first = fixture.run();
  assert.equal(first.status, 0, first.stderr);
  const second = fixture.run();
  assert.equal(second.status, 0, second.stderr);
  assert.ok(lstatSync(fixture.linkTarget).isSymbolicLink());
  assert.equal(realpathSync(fixture.linkTarget), realpathSync(fixture.sdkDir));
});

test("keeps an existing real directory in place", (t) => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());

  mkdirSync(fixture.linkTarget, { recursive: true });
  writeFileSync(path.join(fixture.linkTarget, "installed.txt"), "installed");

  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Keeping existing installed"));
  assert.ok(!lstatSync(fixture.linkTarget).isSymbolicLink());
  assert.equal(
    readFileSync(path.join(fixture.linkTarget, "installed.txt"), "utf8"),
    "installed",
  );
});

test("fails when run outside a package directory", (t) => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());

  rmSync(path.join(fixture.pluginDir, "package.json"));
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("No package.json found"), result.stderr);
  assert.ok(!existsSync(fixture.linkTarget));
});

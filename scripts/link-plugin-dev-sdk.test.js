import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";

import { linkSdkInto, readPluginsUnder } from "./link-plugin-dev-sdk.mjs";

let workDir;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "link-plugin-dev-sdk-"));
});

after(() => {
  rmSync(workDir, { force: true, recursive: true });
});

function makePackage(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");
  return dir;
}

test("readPluginsUnder returns [] for a missing directory", () => {
  assert.deepEqual(readPluginsUnder(join(workDir, "does-not-exist")), []);
});

test("readPluginsUnder finds first-level package directories", () => {
  const parent = join(workDir, "first-level");
  const a = makePackage(join(parent, "a"));
  const b = makePackage(join(parent, "b"));

  assert.deepEqual(readPluginsUnder(parent).sort(), [a, b].sort());
});

test("readPluginsUnder recurses into directories that are not themselves packages", () => {
  // Mirrors the recursive pnpm-workspace exclusion glob: a provider nested
  // deeper than one level must still be discovered.
  const parent = join(workDir, "nested");
  const nested = makePackage(join(parent, "vendor", "my-plugin"));

  assert.deepEqual(readPluginsUnder(parent), [nested]);
});

test("readPluginsUnder stops descending once a package.json is found and skips node_modules", () => {
  const parent = join(workDir, "boundaries");
  const pkg = makePackage(join(parent, "plugin"));
  // A nested package inside an already-matched package must not be returned.
  makePackage(join(pkg, "sub-package"));
  // node_modules must be ignored entirely.
  makePackage(join(parent, "node_modules", "some-dep"));

  assert.deepEqual(readPluginsUnder(parent), [pkg]);
});

test("linkSdkInto creates the plugin-sdk symlink and is idempotent", () => {
  const pkg = makePackage(join(workDir, "link-target"));

  assert.equal(linkSdkInto(pkg), true);

  const link = join(pkg, "node_modules", "@paperclipai", "plugin-sdk");
  assert.ok(lstatSync(link).isSymbolicLink());

  // Second call is a no-op because the link already points at the in-repo SDK.
  assert.equal(linkSdkInto(pkg), false);
});

test("linkSdkInto leaves a real (non-symlink) install in place", () => {
  const pkg = makePackage(join(workDir, "real-install"));
  const scopeDir = join(pkg, "node_modules", "@paperclipai");
  mkdirSync(scopeDir, { recursive: true });
  // Simulate a published-tarball install: a real directory, not a symlink.
  makePackage(join(scopeDir, "plugin-sdk"));

  assert.equal(linkSdkInto(pkg), false);
  assert.ok(!lstatSync(join(scopeDir, "plugin-sdk")).isSymbolicLink());
});

test("linkSdkInto replaces a symlink that points somewhere else", () => {
  const pkg = makePackage(join(workDir, "stale-link"));
  const scopeDir = join(pkg, "node_modules", "@paperclipai");
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync("../somewhere-else", join(scopeDir, "plugin-sdk"), "dir");

  assert.equal(linkSdkInto(pkg), true);
  assert.notEqual(readlinkSync(join(scopeDir, "plugin-sdk")), "../somewhere-else");
  assert.ok(existsSync(scopeDir));
});

// Regression test for the EEXIST race.
//
// linkSdkInto checks for an existing link, removes it, then creates its own.
// Workspace installs run it for several packages at once, so two runs can
// interleave between the check and the create. The loser used to fail the whole
// install with EEXIST.
//
// The window only opens under real parallelism, so this uses separate processes.
// In-process calls cannot interleave, because the underlying fs calls are
// synchronous. Every worker targets the same package directory and converges on a
// shared start instant so they collide. Twelve workers over five rounds is well
// past what the bug needs — one round already fails 11/12 workers without the fix
// — and the redundancy covers machines where a given round happens to miss.
//
// Cost is small enough not to matter: ~2.2s on a GitHub-hosted runner, inside a
// job that takes ~4m.
test("linkSdkInto tolerates a concurrent create of the same link", async () => {
  const moduleUrl = new URL("./link-plugin-dev-sdk.mjs", import.meta.url).href;
  const WORKERS = 12;
  const ROUNDS = 5;
  // Enough for a worker to boot Node and load the module before the barrier.
  const STARTUP_BUDGET_MS = 400;
  // Spin only over the last stretch. Spinning the whole budget would pin every
  // core on a small CI runner for no extra alignment.
  const SPIN_MS = 5;

  const runWorker = (pkg, startAt) =>
    new Promise((resolve) => {
      const source = [
        // Import before the barrier so module load time is not part of the race
        // window; every worker arrives at the symlink call already warm.
        `const { linkSdkInto } = await import(${JSON.stringify(moduleUrl)});`,
        `await new Promise((r) => setTimeout(r, ${startAt} - ${SPIN_MS} - Date.now()));`,
        `while (Date.now() < ${startAt}) {}`,
        `linkSdkInto(${JSON.stringify(pkg)});`,
      ].join("\n");
      const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      // A spawn that never starts (e.g. EAGAIN under process pressure) emits
      // "error" and may never emit "close". Without this the promise would not
      // settle and the run would hang until the CI job timeout.
      child.on("error", (error) => resolve({ code: -1, stderr: String(error) }));
      child.on("close", (code) => resolve({ code, stderr }));
    });

  for (let round = 0; round < ROUNDS; round += 1) {
    const pkg = makePackage(join(workDir, `race-${round}`));
    const startAt = Date.now() + STARTUP_BUDGET_MS;
    const results = await Promise.all(
      Array.from({ length: WORKERS }, () => runWorker(pkg, startAt)),
    );

    const failed = results.filter((result) => result.code !== 0);
    // Workers fail identically, so report the distinct errors rather than one
    // long line per worker.
    const failures = [...new Set(
      failed.map((result) => result.stderr.trim().split("\n").find((line) => line.includes("Error")) ?? "unknown"),
    )];

    assert.deepEqual(failures, [], `round ${round}: ${failed.length}/${WORKERS} workers failed`);
    assert.ok(lstatSync(join(pkg, "node_modules", "@paperclipai", "plugin-sdk")).isSymbolicLink());
  }
});

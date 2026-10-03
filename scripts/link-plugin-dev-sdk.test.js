import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // Build the stale link the same way the script links on this platform. A directory
  // symlink needs SeCreateSymbolicLinkPrivilege on Windows, which a normal developer
  // shell does not hold, so this fixture would fail there rather than test anything.
  const staleDir = join(pkg, "node_modules", "somewhere-else");
  mkdirSync(staleDir, { recursive: true });
  if (process.platform === "win32") {
    symlinkSync(staleDir, join(scopeDir, "plugin-sdk"), "junction");
  } else {
    symlinkSync("../somewhere-else", join(scopeDir, "plugin-sdk"), "dir");
  }

  assert.equal(linkSdkInto(pkg), true);
  const relinked = readlinkSync(join(scopeDir, "plugin-sdk"));
  assert.notEqual(relinked, "../somewhere-else");
  assert.notEqual(relinked, staleDir);
  assert.ok(existsSync(scopeDir));
});

test("linkSdkInto creates a link the module resolver can follow", () => {
  // The link type differs by platform, so assert the property that matters instead:
  // the SDK's own files are reachable through the link that was just created.
  const pkg = makePackage(join(workDir, "resolvable"));

  assert.equal(linkSdkInto(pkg), true);

  const link = join(pkg, "node_modules", "@paperclipai", "plugin-sdk");
  assert.ok(existsSync(join(link, "package.json")));
});

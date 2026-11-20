import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("readPluginsUnder skips linked directories", () => {
  const parent = join(workDir, "linked-discovery");
  mkdirSync(parent);
  const external = makePackage(join(workDir, "external-plugin"));
  symlinkSync(external, join(parent, "linked-plugin"), process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(readPluginsUnder(parent), []);
});

test("linkSdkInto creates the plugin-sdk symlink and is idempotent", () => {
  const pkg = makePackage(join(workDir, "link-target"));

  assert.equal(linkSdkInto(pkg), true);

  const link = join(pkg, "node_modules", "@paperclipai", "plugin-sdk");
  assert.ok(lstatSync(link).isSymbolicLink());

  // Second call is a no-op because the link already points at the in-repo SDK.
  assert.equal(linkSdkInto(pkg), false);
});

test("linkSdkInto works on Windows when ordinary symlink creation is denied", { skip: process.platform !== "win32" }, () => {
  const pkg = makePackage(join(workDir, "without symlink privilege"));
  const source = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, isAbsolute } from "node:path";
    import { fileURLToPath } from "node:url";
    const original = fs.symlinkSync;
    fs.symlinkSync = (target, path, type) => {
      if (type !== "junction") throw Object.assign(new Error("Symbolic link privilege is unavailable"), { code: "EPERM" });
      assert.ok(isAbsolute(target));
      return original(target, path, type);
    };
    syncBuiltinESMExports();
    const { linkSdkInto } = await import(${JSON.stringify(new URL("./link-plugin-dev-sdk.mjs", import.meta.url).href)});
    const pkg = ${JSON.stringify(pkg)};
    assert.equal(linkSdkInto(pkg), true);
    assert.equal(fs.realpathSync(join(pkg, "node_modules", "@paperclipai", "plugin-sdk")),
      fs.realpathSync(fileURLToPath(${JSON.stringify(new URL("../packages/plugins/sdk", import.meta.url).href)})));
    assert.equal(linkSdkInto(pkg), false);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
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
  const elsewhere = makePackage(join(workDir, "elsewhere"));
  symlinkSync(elsewhere, join(scopeDir, "plugin-sdk"), process.platform === "win32" ? "junction" : "dir");

  assert.equal(linkSdkInto(pkg), true);
  assert.notEqual(readlinkSync(join(scopeDir, "plugin-sdk")), elsewhere);
  assert.ok(existsSync(join(elsewhere, "package.json")));
  assert.ok(existsSync(scopeDir));
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertPiNodeSystemDependencies, applyPiUndiciSecurityOverride, assertPiUndiciArchive, assertPiUndiciArchiveEntries, assertPiUndiciSecurityOverride, PI_UNDICI_SECURITY_OVERRIDE, PI_DISTRIBUTION_PINS, materializePiDistribution, piDistributionInstallCommand, verifyLockedPiPackageGraph, writePiDistributionManifest } from "./materialize-pi-distribution.mjs";
import { verifyPiRuntimeManifest } from "../src/drivers/acpx/pi-verified-runtime.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "paperclip-pi-distribution-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, data) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), data); };
  return { root, write };
}

test("distribution lock closes exact wrapper, SDK and upstream Pi graph with integrity", async () => {
  const pkg = JSON.parse(await readFile(new URL("./pi-distribution/package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("./pi-distribution/package-lock.json", import.meta.url), "utf8"));
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  assert.deepEqual(pkg.overrides, { "@earendil-works/pi-coding-agent@0.84.2": { undici: "8.10.2" } });
  assert.equal(lock.packages[PI_UNDICI_SECURITY_OVERRIDE.path].version, "8.10.2");
  assert.equal(PI_DISTRIBUTION_PINS.nodeVersion, "24.21.0");
  assert.equal(PI_DISTRIBUTION_PINS.nodeBundledUndici, "7.29.1");
  assert.deepEqual(pkg.dependencies, { "@agentclientprotocol/sdk": "0.26.0", "@earendil-works/pi-coding-agent": "0.84.2", "pi-acp": "0.0.33", zod: "3.25.76" });
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    if (/node_modules\/@earendil-works\/pi-[^/]+$/.test(path)) assert.equal(entry.version, PI_DISTRIBUTION_PINS.runtime);
  }
  assert.ok(lock.packages["node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-telemetry"]);
  assert.ok(piDistributionInstallCommand().includes("--ignore-scripts"));
  assert.ok(piDistributionInstallCommand().includes("--include=optional"));
  assert.equal(piDistributionInstallCommand()[0], "ci");
});

test("package verification rejects missing, version-shifted and incomplete shrinkwrap graphs", async (t) => {
  const { root, write } = await fixture(t);
  const pi = "node_modules/@earendil-works/pi-coding-agent";
  const nested = "node_modules/fixture-package";
  const entry = { version: "1.0.0", resolved: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz", integrity: "sha512-YWJjZA==" };
  const lock = { lockfileVersion: 3, packages: {
    [pi]: { ...entry, version: "0.84.2" }, [`${pi}/${nested}`]: entry,
  } };
  await write(`${pi}/package.json`, JSON.stringify({ version: "0.84.2" }));
  await write(`${pi}/npm-shrinkwrap.json`, JSON.stringify({ version: "0.84.2", lockfileVersion: 3, packages: { [nested]: entry } }));
  await assert.rejects(verifyLockedPiPackageGraph(root, lock), /missing locked package/);
  await write(`${pi}/${nested}/package.json`, JSON.stringify({ version: "1.0.0" }));
  assert.equal(await verifyLockedPiPackageGraph(root, lock), 2);
  await write(`${pi}/${nested}/package.json`, JSON.stringify({ version: "1.0.1" }));
  await assert.rejects(verifyLockedPiPackageGraph(root, lock), /differs from its lock/);
  await write(`${pi}/${nested}/package.json`, JSON.stringify({ version: "1.0.0" }));
  const missing = structuredClone(lock); delete missing.packages[`${pi}/${nested}`];
  await assert.rejects(verifyLockedPiPackageGraph(root, missing), /dropped or changed shrinkwrapped/);
});

test("manifest includes resources and emitted extension and rejects byte changes or links escaping the graph", async (t) => {
  const { root, write } = await fixture(t);
  await write("node/bin/node", "verified-node");
  await write("node_modules/@earendil-works/pi-coding-agent/dist/cli.js", "verified-pi");
  await write("node_modules/pi-acp/dist/index.js", "verified-wrapper");
  await write("node_modules/pi-acp/dist/paperclip-runtime.js", "verified-helper");
  await write("extensions/paperclip.js", "verified-extension");
  await write("node_modules/native/runtime.node", Buffer.from([0, 1, 2]));
  await write("node_modules/native/image.wasm", Buffer.from([4, 5, 6]));
  await write("node_modules/native/theme.json", '{"name":"theme"}');
  const result = await writePiDistributionManifest(root);
  assert.equal(result.manifest.files.length, 8);
  assert.match(result.environment.PAPERCLIP_PI_EXTENSION_PATH, /extensions\/paperclip\.js$/);
  await write("node_modules/native/image.wasm", "tampered");
  await assert.rejects(verifyPiRuntimeManifest(root, result.manifest), /differs from its qualified manifest/);
  await symlink("/outside", join(root, "escape"));
  await assert.rejects(writePiDistributionManifest(root), /escapes its pack/);
});

test("materialization refuses relative, root and existing outputs before installation", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(materializePiDistribution({ outputRoot: "relative" }), /must be absolute/);
  await assert.rejects(materializePiDistribution({ outputRoot: "/" }), /unsafe/);
  await assert.rejects(materializePiDistribution({ outputRoot: root }), /already exists/);
});

test("Node dependency inspection rejects Homebrew and non-system Linux libraries", () => {
  assert.throws(() => assertPiNodeSystemDependencies("node:\n\t@rpath/libnode.147.dylib (version 0)\n", "darwin"), /unbundled/);
  assert.doesNotThrow(() => assertPiNodeSystemDependencies("node:\n\t/usr/lib/libSystem.B.dylib (version 0)\n", "darwin"));
  assert.throws(() => assertPiNodeSystemDependencies("libnode.so => /opt/lib/libnode.so (0x000)\n", "linux"), /unbundled/);
  assert.doesNotThrow(() => assertPiNodeSystemDependencies("linux-vdso.so.1 (0x000)\nlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x000)\n/lib64/ld-linux-x86-64.so.2 (0x000)\n", "linux"));
});


test("security exception admits only the exact upstream-to-fixed Undici tuple", async (t) => {
  const { root, write } = await fixture(t);
  const pi = "node_modules/@earendil-works/pi-coding-agent";
  const pin = PI_UNDICI_SECURITY_OVERRIDE;
  const lock = { lockfileVersion: 3, packages: {
    [pi]: { version: "0.84.2", resolved: "https://registry.npmjs.org/pi.tgz", integrity: "sha512-YWJjZA==" },
    [pin.path]: { ...pin.fixed },
  } };
  const shrinkwrap = { version: "0.84.2", lockfileVersion: 3, packages: { [pin.upstreamPath]: { ...pin.previous } } };
  await write(`${pi}/package.json`, JSON.stringify({ version: "0.84.2" }));
  await write(`${pi}/npm-shrinkwrap.json`, JSON.stringify(shrinkwrap));
  // npm ci's vulnerable copy cannot pass the post-replacement installed check.
  await write(`${pin.path}/package.json`, JSON.stringify({ name: "undici", version: "8.9.0" }));
  await assert.rejects(verifyLockedPiPackageGraph(root, lock), /differs from its lock/);
  await write(`${pin.path}/package.json`, JSON.stringify({ name: "undici", version: "8.10.2" }));
  assert.equal(await verifyLockedPiPackageGraph(root, lock), 2);
  for (const field of ["version", "resolved", "integrity"]) {
    const badOld = structuredClone(shrinkwrap); badOld.packages[pin.upstreamPath][field] = "tampered";
    assert.throws(() => assertPiUndiciSecurityOverride(lock, badOld), /exact reviewed old\/new pins/);
    const badNew = structuredClone(lock); badNew.packages[pin.path][field] = "tampered";
    assert.throws(() => assertPiUndiciSecurityOverride(badNew, shrinkwrap), /exact reviewed old\/new pins/);
  }
  const moved = structuredClone(lock); moved.packages["node_modules/undici"] = moved.packages[pin.path]; delete moved.packages[pin.path];
  assert.throws(() => assertPiUndiciSecurityOverride(moved, shrinkwrap), /exact reviewed/);
  const altered = structuredClone(shrinkwrap); altered.packages[pin.upstreamPath].integrity = "sha512-YWJjZA==";
  await write(`${pi}/npm-shrinkwrap.json`, JSON.stringify(altered));
  await assert.rejects(verifyLockedPiPackageGraph(root, lock), /exact reviewed/);
});

test("security tarball rejects tampering, traversal, links and unbounded entry lists", () => {
  assert.throws(() => assertPiUndiciArchive(Buffer.from("not the pinned tarball")), /integrity pin/);
  assert.throws(() => assertPiUndiciArchive(Buffer.alloc(4 * 1024 * 1024 + 1)), /integrity pin/);
  const goodPaths = "package/package.json\npackage/index.js\n";
  const goodListing = "-rw-r--r-- package/package.json\n-rw-r--r-- package/index.js\n";
  assert.doesNotThrow(() => assertPiUndiciArchiveEntries(goodPaths, goodListing));
  for (const path of ["/absolute", "package/../escape", "other/index.js", "package/./index.js", "package/evil\\name"]) {
    assert.throws(() => assertPiUndiciArchiveEntries(`package/package.json\n${path}\n`, goodListing), /unsafe entry/);
  }
  assert.throws(() => assertPiUndiciArchiveEntries(goodPaths, goodListing.replace("-rw", "lrw")), /unsafe entry/);
  assert.throws(() => assertPiUndiciArchiveEntries(goodPaths, goodListing.replace("-rw", "hrw")), /unsafe entry/);
  assert.throws(() => assertPiUndiciArchiveEntries(goodPaths.repeat(257), goodListing.repeat(257)), /unsafe entry/);
});


test("tampered replacement leaves the original dependency intact and cleans staging", async (t) => {
  const { root, write } = await fixture(t);
  const pin = PI_UNDICI_SECURITY_OVERRIDE;
  const pi = "node_modules/@earendil-works/pi-coding-agent";
  const lock = { packages: { [pin.path]: { ...pin.fixed } } };
  await write(`${pi}/npm-shrinkwrap.json`, JSON.stringify({ version: "0.84.2", lockfileVersion: 3, packages: { [pin.upstreamPath]: { ...pin.previous } } }));
  const original = JSON.stringify({ name: "undici", version: "8.9.0" });
  await write(`${pin.path}/package.json`, original);
  const savedFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = savedFetch; });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, pin.fixed.resolved);
    assert.equal(options.redirect, "error");
    return new Response("tampered archive");
  };
  await assert.rejects(applyPiUndiciSecurityOverride(root, lock), /integrity pin/);
  assert.equal(await readFile(join(root, pin.path, "package.json"), "utf8"), original);
  assert.deepEqual(await readdir(join(root, pi, "node_modules")), ["undici"]);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertPiNodeSystemDependencies, PI_BRACE_SECURITY_PATCH_SHA256, PI_DISTRIBUTION_PINS, materializePiDistribution, resolvePiBundledNpm, piDistributionInstallCommand, verifyLockedPiPackageGraph, writePiDistributionManifest } from "./materialize-pi-distribution.mjs";
import { verifyPiRuntimeManifest } from "../src/drivers/acpx/pi-verified-runtime.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "paperclip-pi-distribution-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, data) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), data); };
  return { root, write };
}

test("plain Node loads the source materializer without a TypeScript import resolver", () => {
  const materializer = new URL("./materialize-pi-distribution.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { materializePiDistribution } = await import(${JSON.stringify(materializer)});
    const assert = await import("node:assert/strict");
    await assert.rejects(materializePiDistribution({ outputRoot: "relative" }), /must be absolute/);
  `], { env: { PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8" }, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("distribution lock closes exact wrapper, SDK and upstream Pi graph with integrity", async () => {
  const pkg = JSON.parse(await readFile(new URL("./pi-distribution/package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("./pi-distribution/package-lock.json", import.meta.url), "utf8"));
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  assert.equal(pkg.overrides, undefined);
  assert.equal(lock.packages["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"].version, "5.0.12");
  const patch = await readFile(new URL("../../../patches/brace-expansion@5.0.9.patch", import.meta.url));
  assert.equal(createHash("sha256").update(patch).digest("hex"), PI_BRACE_SECURITY_PATCH_SHA256);
  assert.equal(lock.packages["node_modules/@earendil-works/pi-coding-agent/node_modules/undici"].version, "8.10.2");
  assert.equal(PI_DISTRIBUTION_PINS.nodeVersion, "24.21.0");
  assert.equal(PI_DISTRIBUTION_PINS.nodeBundledUndici, "7.29.1");
  assert.deepEqual(pkg.dependencies, { "@agentclientprotocol/sdk": "0.26.0", "@earendil-works/pi-coding-agent": "1.0.0", "pi-acp": "0.0.33", zod: "3.25.76" });
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

test("only the exact brace-expansion security correction may differ from Pi's shrinkwrap", async (t) => {
  const { root, write } = await fixture(t);
  const pi = "node_modules/@earendil-works/pi-coding-agent";
  const old = { version: "5.0.9", resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz", integrity: "sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==" };
  const lock = JSON.parse(await readFile(new URL("./pi-distribution/package-lock.json", import.meta.url), "utf8"));
  const brace = lock.packages[`${pi}/node_modules/brace-expansion`];
  const minimal = { lockfileVersion: 3, packages: { [pi]: lock.packages[pi], [`${pi}/node_modules/brace-expansion`]: brace } };
  await write(`${pi}/package.json`, JSON.stringify({ version: "1.0.0" }));
  await write(`${pi}/npm-shrinkwrap.json`, JSON.stringify({ version: "1.0.0", lockfileVersion: 3, packages: { "node_modules/brace-expansion": old } }));
  await write(`${pi}/node_modules/brace-expansion/package.json`, JSON.stringify({ version: "5.0.9" }));
  await assert.rejects(verifyLockedPiPackageGraph(root, minimal), /differs from its lock/);
  await write(`${pi}/node_modules/brace-expansion/package.json`, JSON.stringify({ version: "5.0.12" }));
  assert.equal(await verifyLockedPiPackageGraph(root, minimal), 2);
  for (const field of ["version", "resolved", "integrity"]) {
    const tampered = structuredClone(minimal); tampered.packages[`${pi}/node_modules/brace-expansion`][field] += "-changed";
    await assert.rejects(verifyLockedPiPackageGraph(root, tampered), /unpin|differs|dropped or changed/);
  }
});

test("package verification rejects missing, version-shifted and incomplete shrinkwrap graphs", async (t) => {
  const { root, write } = await fixture(t);
  const pi = "node_modules/@earendil-works/pi-coding-agent";
  const nested = "node_modules/fixture-package";
  const entry = { version: "1.0.0", resolved: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz", integrity: "sha512-YWJjZA==" };
  const lock = { lockfileVersion: 3, packages: {
    [pi]: { ...entry, version: "1.0.0" }, [`${pi}/${nested}`]: entry,
  } };
  await write(`${pi}/package.json`, JSON.stringify({ version: "1.0.0" }));
  await write(`${pi}/npm-shrinkwrap.json`, JSON.stringify({ version: "1.0.0", lockfileVersion: 3, packages: { [nested]: entry } }));
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


test("setup selects the exact archive npm and rejects wrong versions or linked entrypoints", async (t) => {
  const fixtureRoot = await fixture(t);
  const root = await realpath(fixtureRoot.root), write = fixtureRoot.write;
  const prefix = "lib/node_modules/npm/";
  await write(prefix + "package.json", JSON.stringify({ name: "npm", version: "11.19.0" }));
  await write(prefix + "bin/npm-cli.js", "// pinned archive fixture");
  assert.equal(await resolvePiBundledNpm(root), join(root, prefix, "bin/npm-cli.js"));
  await write(prefix + "package.json", JSON.stringify({ name: "npm", version: "10.9.7" }));
  await assert.rejects(resolvePiBundledNpm(root), /unexpected npm version/);
  await write(prefix + "package.json", JSON.stringify({ name: "npm", version: "11.19.0" }));
  await rm(join(root, prefix, "bin/npm-cli.js"));
  await symlink(join(root, prefix, "package.json"), join(root, prefix, "bin/npm-cli.js"));
  await assert.rejects(resolvePiBundledNpm(root), /invalid archive entry/);
});

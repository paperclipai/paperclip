import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertPiNodeSystemDependencies, downloadPinnedPiNodeArchive, PI_BRACE_SECURITY_PATCH_SHA256, PI_DISTRIBUTION_PINS, materializePiDistribution, resolvePiBundledNpm, piDistributionInstallCommand, verifyLockedPiPackageGraph, writePiDistributionManifest } from "./materialize-pi-distribution.mjs";
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

test("Node archive download retries transport stalls and records each failed attempt", async () => {
  const archive = Buffer.from("pinned node archive");
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  const stalledBody = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError")); } });
  const replies = [
    () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    () => Promise.resolve(new Response(stalledBody)),
    () => Promise.resolve(new Response(archive)),
  ];
  const signals = []; const warnings = [];
  const bytes = await downloadPinnedPiNodeArchive({
    url: "https://nodejs.org/dist/fixture.tar.gz", archiveSha256, retryDelayMs: 0, warn: (message) => warnings.push(message),
    fetchImpl: (url, init) => { signals.push(init.signal); assert.equal(init.redirect, "error"); return replies.shift()(); },
  });
  assert.deepEqual(bytes, archive);
  assert.equal(signals.length, 3);
  assert.equal(new Set(signals).size, 3, "each attempt needs a fresh timeout");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /attempt 1\/3 failed: The operation was aborted due to timeout; retrying/);
});

test("Node archive download deadline aborts stalled headers and stalled bodies", async () => {
  const archive = Buffer.from("pinned node archive");
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  const abortWith = (signal, fail) => signal.addEventListener("abort", () => fail(signal.reason), { once: true });
  const replies = [
    // Headers never arrive; only the supplied deadline can end this attempt.
    (signal) => new Promise((_, reject) => abortWith(signal, reject)),
    // Headers arrive, then the body stalls after one chunk until the same deadline fires.
    (signal) => Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); abortWith(signal, (reason) => controller.error(reason)); } }))),
    () => Promise.resolve(new Response(archive)),
  ];
  const warnings = [];
  const bytes = await downloadPinnedPiNodeArchive({
    url: "https://nodejs.org/dist/fixture.tar.gz", archiveSha256, timeoutMs: 20, retryDelayMs: 0, warn: (message) => warnings.push(message),
    fetchImpl: (url, init) => replies.shift()(init.signal),
  });
  assert.deepEqual(bytes, archive);
  assert.equal(warnings.length, 2);
  for (const warning of warnings) assert.match(warning, /The operation was aborted due to timeout; retrying/);
});

test("Node archive download releases a rejected response before the next attempt", async () => {
  const archive = Buffer.from("pinned node archive");
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  const events = [];
  const busy = () => new Response(new ReadableStream({ cancel() { events.push("cancel"); } }), { status: 503 });
  const replies = [busy, () => new Response(archive)];
  await downloadPinnedPiNodeArchive({
    url: "https://nodejs.org/dist/fixture.tar.gz", archiveSha256, retryDelayMs: 0, warn: () => {},
    fetchImpl: () => { events.push("fetch"); return Promise.resolve(replies.shift()()); },
  });
  assert.deepEqual(events, ["fetch", "cancel", "fetch"]);
  events.length = 0;
  await assert.rejects(downloadPinnedPiNodeArchive({
    url: "https://nodejs.org/dist/fixture.tar.gz", archiveSha256, retryDelayMs: 0, warn: () => assert.fail("must not retry"),
    fetchImpl: () => { events.push("fetch"); return Promise.resolve(new Response(new ReadableStream({ cancel() { events.push("cancel"); } }), { status: 404 })); },
  }), /returned HTTP 404/);
  assert.deepEqual(events, ["fetch", "cancel"]);
});

test("Node archive download names the exhausted request instead of an anonymous timeout", async () => {
  let calls = 0;
  await assert.rejects(downloadPinnedPiNodeArchive({
    url: "https://nodejs.org/dist/fixture.tar.gz", archiveSha256: "0".repeat(64), retryDelayMs: 0, warn: () => {},
    fetchImpl: () => { calls++; return Promise.reject(new TypeError("fetch failed")); },
  }), /^Error: Pinned Pi Node download failed after 3 attempts: fetch failed$/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(downloadPinnedPiNodeArchive({
    url: "https://nodejs.org/dist/fixture.tar.gz", archiveSha256: "0".repeat(64), retryDelayMs: 0, warn: () => {},
    fetchImpl: () => { calls++; return Promise.resolve(new Response("busy", { status: 503 })); },
  }), /failed after 3 attempts: Pinned Pi Node download returned HTTP 503/);
  assert.equal(calls, 3);
});

test("Node archive download fails closed without retrying pin, bound, client or cancellation failures", async () => {
  const options = { url: "https://nodejs.org/dist/fixture.tar.gz", archiveSha256: "0".repeat(64), retryDelayMs: 0, warn: () => assert.fail("must not retry") };
  let calls = 0;
  const once = (response) => () => { calls++; return Promise.resolve(response()); };
  await assert.rejects(downloadPinnedPiNodeArchive({ ...options, fetchImpl: once(() => new Response("tampered")) }), /does not match its release pin/);
  await assert.rejects(downloadPinnedPiNodeArchive({ ...options, fetchImpl: once(() => new Response("missing", { status: 404 })) }), /returned HTTP 404/);
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(128 * 1024 * 1024 + 1)); controller.close(); } });
  await assert.rejects(downloadPinnedPiNodeArchive({ ...options, fetchImpl: once(() => new Response(oversized)) }), /exceeds its bound/);
  assert.equal(calls, 3);
  let checks = 0;
  await assert.rejects(downloadPinnedPiNodeArchive({
    ...options, warn: () => {}, checkCancelled: () => { if (++checks > 1) throw new Error("cancelled"); },
    fetchImpl: () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
  }), /cancelled/);
});

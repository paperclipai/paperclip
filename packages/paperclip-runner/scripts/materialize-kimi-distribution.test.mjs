import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assertKimiNodeSystemDependencies, buildKimiDistribution, kimiDistributionEnvironment, kimiDistributionInstallCommand, materializeKimiDistribution, runKimiBuildCommand, verifyLockedKimiPackageGraph } from "./materialize-kimi-distribution.mjs";
import { KIMI_DISTRIBUTION_LOCK_SHA256, KIMI_NODE_DISTRIBUTIONS } from "../src/drivers/acpx/kimi-closure-pins.ts";
import { inventoryKimiRuntimeFiles, kimiRuntimeClosureDigest } from "../src/drivers/acpx/kimi-runtime-files.ts";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-kimi-distribution-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, content) => { const file = join(root, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, content); };
  return { root, write };
}

test("Kimi's portable graph pins public integrity and excludes lifecycle and optional TUI dependencies", async () => {
  const bytes = await readFile(new URL("./kimi-distribution/package-lock.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), KIMI_DISTRIBUTION_LOCK_SHA256);
  const lock = JSON.parse(bytes.toString("utf8"));
  const pkg = JSON.parse(await readFile(new URL("./kimi-distribution/package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.dependencies, { "@moonshot-ai/kimi-code": "2.3.3" });
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  assert.equal(lock.packages["node_modules/@moonshot-ai/kimi-code"].integrity, "sha512-3V8bycucf9KgPRH27S8De2u0ip84/Ry3FpNn6gi5z9JmoEHt9vxiYHHZqiMdyDf5nPm4bv+YKGwKEQL4oYpRTw==");
  assert.equal(kimiDistributionInstallCommand()[0], "ci");
  assert.ok(kimiDistributionInstallCommand().includes("--ignore-scripts"));
  assert.ok(kimiDistributionInstallCommand().includes("--omit=optional"));
  assert.ok(kimiDistributionInstallCommand().includes("--registry=https://registry.npmjs.org"));
  assert.deepEqual(Object.keys(KIMI_NODE_DISTRIBUTIONS).sort(), ["darwin-arm64", "linux-x64"]);
});

test("distribution build admits network settings without provider keys or Node injection", () => {
  const network = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HTTPS_PROXY: "http://proxy.invalid", NODE_EXTRA_CA_CERTS: "/public/ca.pem" };
  assert.deepEqual(kimiDistributionEnvironment({ ...network, HOME: "/private/home", KIMI_MODEL_API_KEY: "canary-secret", NPM_TOKEN: "canary-secret", NODE_OPTIONS: "--require /foreign.js", NODE_PATH: "/foreign", NODE_TLS_REJECT_UNAUTHORIZED: "0" }), network);
});

test("setup cancellation physically stops an in-flight owned child", { timeout: 5_000 }, async t => {
  const { root } = await fixture(t), pidFile = join(root, "pid");
  const controller = new AbortController();
  const result = runKimiBuildCommand(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", pidFile], { env: {}, timeout: 3_000 }, undefined, controller.signal).then(() => null, error => error);
  let pid;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { pid = Number(await readFile(pidFile, "utf8")); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; await delay(10); }
    }
    assert.ok(Number.isSafeInteger(pid) && pid > 0, "The real child did not start");
    controller.abort();
    assert.equal((await result).code, "ABORT_ERR");
    assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
  } finally { controller.abort(); await result; }
});

test("setup cancellation aborts the pending download and removes its staging tree", { timeout: 5_000 }, async t => {
  const { root } = await fixture(t), controller = new AbortController();
  let started;
  const downloading = new Promise(resolve => { started = resolve; });
  t.mock.method(globalThis, "fetch", (_url, options) => new Promise((_resolve, reject) => {
    started(); options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }));
  const result = buildKimiDistribution({ outputRoot: join(root, "output"), signal: controller.signal });
  await downloading; controller.abort();
  await assert.rejects(result, error => error.name === "AbortError");
  assert.deepEqual(await readdir(root), []);
});

test("the installed graph rejects version drift and optional packages", async t => {
  const { root, write } = await fixture(t);
  const entry = { version: "2.3.3", resolved: "https://registry.npmjs.org/@moonshot-ai/kimi-code/-/kimi-code-2.3.3.tgz", integrity: "sha512-YWJjZA==" };
  const lock = { lockfileVersion: 3, packages: { "": { dependencies: { "@moonshot-ai/kimi-code": "2.3.3" } }, "node_modules/@moonshot-ai/kimi-code": entry, "node_modules/optional-native": { ...entry, optional: true } } };
  await write("node_modules/@moonshot-ai/kimi-code/package.json", '{"version":"2.3.3"}');
  assert.equal(await verifyLockedKimiPackageGraph(root, lock), 1);
  await write("node_modules/@moonshot-ai/kimi-code/package.json", '{"version":"2.3.4"}');
  await assert.rejects(verifyLockedKimiPackageGraph(root, lock), /differs from its lock/);
  await write("node_modules/@moonshot-ai/kimi-code/package.json", '{"version":"2.3.3"}');
  await write("node_modules/optional-native/package.json", '{"version":"2.3.3"}');
  await assert.rejects(verifyLockedKimiPackageGraph(root, lock), /optional TUI dependency/);
});

test("inventory binds native assets, workers, permissions and bytes in stable path order", async t => {
  const { root, write } = await fixture(t);
  await write("node_modules/provider/worker.mjs", "worker");
  await write("node_modules/provider/native/addon.node", Buffer.from([0, 1, 2, 3]));
  await write("node/bin/node", "node");
  const first = await inventoryKimiRuntimeFiles(root);
  assert.deepEqual(first.map(entry => entry.path), ["node/bin/node", "node_modules/provider/native/addon.node", "node_modules/provider/worker.mjs"]);
  const digest = kimiRuntimeClosureDigest(first);
  await write("node_modules/provider/worker.mjs", "worker changed");
  assert.notEqual(kimiRuntimeClosureDigest(await inventoryKimiRuntimeFiles(root)), digest);
  await chmod(join(root, "node/bin/node"), 0o755);
  assert.equal((await inventoryKimiRuntimeFiles(root))[0].executable, true);
});

test("inventory rejects external links, hardlinks and special files", async t => {
  const { root, write } = await fixture(t);
  await write("original", "content");
  await symlink("/outside", join(root, "escape"));
  await assert.rejects(inventoryKimiRuntimeFiles(root), /symbolic link/);
  await rm(join(root, "escape"));
  await link(join(root, "original"), join(root, "alias"));
  await assert.rejects(inventoryKimiRuntimeFiles(root), /invalid file/);
});

test("setup refuses relative, root, unsupported and existing outputs before network work", async t => {
  const { root } = await fixture(t);
  for (const operation of [buildKimiDistribution, materializeKimiDistribution]) {
    await assert.rejects(operation({ outputRoot: "relative" }), /must be absolute/);
    await assert.rejects(operation({ outputRoot: "/" }), /unsafe/);
    await assert.rejects(operation({ outputRoot: join(root, "output"), target: "linux-arm64" }), /unsupported/);
    await assert.rejects(operation({ outputRoot: root }), /already exists/);
  }
});

test("the bundled Node may depend only on platform system libraries", () => {
  assert.doesNotThrow(() => assertKimiNodeSystemDependencies("node:\n /usr/lib/libSystem.B.dylib (version 0)\n", "darwin"));
  assert.throws(() => assertKimiNodeSystemDependencies("node:\n /opt/homebrew/lib/libnode.dylib (version 0)\n", "darwin"), /unbundled/);
  assert.doesNotThrow(() => assertKimiNodeSystemDependencies("linux-vdso.so.1 (0x0)\nlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x0)\n/lib64/ld-linux-x86-64.so.2 (0x0)\n", "linux"));
  assert.throws(() => assertKimiNodeSystemDependencies("libcustom.so => /opt/private/libcustom.so (0x0)\n", "linux"), /unbundled/);
});

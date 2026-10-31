import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { bundleKimiProvisioner } from "./build-verified-provider-entrypoints.mjs";
import { KIMI_DISTRIBUTION_CLOSURE_SHA256 } from "../src/drivers/acpx/kimi-closure-pins.ts";

const run = promisify(execFile);

test("installed Kimi setup is self-contained, rejects corrupt assets and cancels pending downloads", { timeout: 10_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-kimi-public-layout-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, "package"), cli = join(pkg, "dist/vendor/paperclip-runner/cli");
  await mkdir(cli, { recursive: true });
  await writeFile(join(pkg, "package.json"), '{"name":"@paperclipai/server","type":"module"}');
  await writeFile(join(pkg, "dist/index.js"), 'throw Error("server must not start");');
  await writeFile(join(cli, "acpx-runtime-sidecar.cjs"), "// installed layout fixture");
  const entry = join(cli, "provision-kimi.cjs");
  const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const result = await bundleKimiProvisioner({ outputRoot: cli });
  for (const output of Object.values(result.metafile.outputs)) for (const dependency of output.imports) assert.match(dependency.path, /^node:/);
  assert.deepEqual((await readdir(join(cli, "kimi-provision-inputs"))).sort(), ["package-lock.json", "package.json"]);
  for (const name of ["package-lock.json", "package.json"]) assert.deepEqual(await readFile(join(cli, "kimi-provision-inputs", name)), await readFile(join(packageRoot, "scripts/kimi-distribution", name)));
  const setup = createRequire(import.meta.url)(entry);
  const layout = await setup.provisionKimiPackageRoot(entry);
  assert.equal(layout.root, pkg);
  assert.equal(layout.assetRoot, join(pkg, "dist/vendor/paperclip-runner"));
  const linked = join(cli, "linked.cjs"); await symlink(entry, linked);
  await assert.rejects(setup.provisionKimiPackageRoot(linked), /installed entrypoint/);
  assert.deepEqual(setup.provisionEnvironment({ PATH: "/usr/bin:/bin", HTTPS_PROXY: "http://127.0.0.1:9", KIMI_MODEL_API_KEY: "sensitive-canary", HOME: "/private/home", NODE_OPTIONS: "--require /foreign", NODE_PATH: "/foreign", NPM_TOKEN: "sensitive-canary" }), { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HTTPS_PROXY: "http://127.0.0.1:9" });
  const target = `${process.platform}-${process.arch}`;
  const parent = join(layout.assetRoot, "provider-assets/kimi");
  await mkdir(join(parent, target, "runtime"), { recursive: true });
  const deny = join(root, "deny.cjs");
  await writeFile(deny, `process.nextTick(()=>{const assert=require('node:assert/strict');for(const key of ['KIMI_MODEL_API_KEY','NPM_TOKEN','HOME','NODE_OPTIONS','NODE_PATH'])assert.equal(process.env[key],undefined,key)});const fail=()=>{throw Error('UNEXPECTED_NETWORK_OR_CHILD')};globalThis.fetch=fail;for(const m of ['node:net','node:tls','node:http','node:https']){const x=require(m);for(const key of ['connect','createConnection','request','get'])if(key in x)x[key]=fail}const c=require('node:child_process');for(const key of ['spawn','execFile','exec'])c[key]=fail;`);
  const child = spawnSync(process.execPath, ["--require", deny, entry], { env: { PATH: "/usr/bin:/bin", KIMI_MODEL_API_KEY: "sensitive-canary", NPM_TOKEN: "sensitive-canary", HOME: "/private/home", NODE_OPTIONS: "", NODE_PATH: "/foreign" }, encoding: "utf8", timeout: 10_000 });
  assert.ifError(child.error); assert.equal(child.status, 1); assert.match(child.stderr, /Kimi setup failed/);
  assert.doesNotMatch(child.stderr + child.stdout, /UNEXPECTED_NETWORK_OR_CHILD|sensitive-canary/);
  assert.deepEqual(await readdir(parent), [target]);
  assert.equal(JSON.parse(await readFile(join(pkg, "package.json"), "utf8")).name, "@paperclipai/server");
  await rm(join(parent, target), { recursive: true });
  const ready = join(root, "download-ready"), aborted = join(root, "download-aborted");
  const preload = join(root, "pending-download.cjs");
  await writeFile(preload, `globalThis.fetch=(_url,{signal})=>new Promise((_resolve,reject)=>{const pending=setInterval(()=>{},1000);require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');signal.addEventListener('abort',()=>{clearInterval(pending);require('node:fs').writeFileSync(${JSON.stringify(aborted)},'aborted');reject(signal.reason)},{once:true})});`);
  const cancelled = spawn(process.execPath, ["--require", preload, entry], { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "ignore", "pipe"] });
  const closed = once(cancelled, "close");
  let stderr = ""; cancelled.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
  const kill = setTimeout(() => cancelled.kill("SIGKILL"), 5_000);
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await readFile(ready); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; await delay(10); }
    }
    assert.equal(await readFile(ready, "utf8"), "ready");
    cancelled.kill("SIGTERM");
    const [code, signal] = await closed;
    assert.equal(code, 1); assert.equal(signal, null);
    assert.match(stderr, /Kimi setup failed/);
    assert.equal(await readFile(aborted, "utf8"), "aborted");
    assert.deepEqual(await readdir(parent), []);
  } finally { clearTimeout(kill); if (cancelled.exitCode === null && cancelled.signalCode === null) { cancelled.kill("SIGKILL"); await closed; } }
});

test("fresh archived installed provisioner downloads the exact closure, reuses it offline and rejects tampering", {
  skip: process.env.PAPERCLIP_TEST_KIMI_PUBLIC_SETUP !== "1" && "Set PAPERCLIP_TEST_KIMI_PUBLIC_SETUP=1 for public registry downloads; no model calls or provider credentials",
  timeout: 180_000,
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-kimi-public-setup-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packed = join(root, "packed"), pkg = join(packed, "package"), cli = join(pkg, "dist/vendor/paperclip-runner/cli");
  await mkdir(cli, { recursive: true });
  await writeFile(join(pkg, "package.json"), '{"name":"@paperclipai/server","type":"module"}');
  await writeFile(join(pkg, "dist/index.js"), 'throw Error("server must not start");');
  await writeFile(join(cli, "acpx-runtime-sidecar.cjs"), "// installed layout fixture");
  await bundleKimiProvisioner({ outputRoot: cli });
  const archive = join(root, "setup.tgz"), installed = join(root, "installed");
  await run("tar", ["-czf", archive, "-C", packed, "package"], { timeout: 10_000 });
  await mkdir(installed);
  await run("tar", ["-xzf", archive, "-C", installed], { timeout: 10_000 });
  const entry = join(installed, "package/dist/vendor/paperclip-runner/cli/provision-kimi.cjs");
  const api = createRequire(import.meta.url)(entry);
  const environment = api.provisionEnvironment(process.env);
  const fresh = await run(process.execPath, ["--use-env-proxy", entry], { env: { ...environment, KIMI_API_KEY: "sensitive-canary", NPM_TOKEN: "sensitive-canary", HOME: "/private/foreign-home" }, timeout: 120_000, maxBuffer: 1024 * 1024 });
  assert.doesNotMatch(fresh.stdout + fresh.stderr, /sensitive-canary/);
  const receipt = JSON.parse(fresh.stdout.trim());
  assert.equal(receipt.status, "installed_verified");
  const target = `${process.platform}-${process.arch}`;
  const assets = join(installed, "package/dist/vendor/paperclip-runner/provider-assets/kimi", target);
  const metadata = JSON.parse(await readFile(join(assets, "kimi-distribution.json"), "utf8"));
  assert.equal(metadata.nativeClosureSha256, KIMI_DISTRIBUTION_CLOSURE_SHA256[target]);
  const offline = { ...environment, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9", NO_PROXY: "", no_proxy: "" };
  const reused = await run(process.execPath, ["--use-env-proxy", entry], { env: offline, timeout: 20_000, maxBuffer: 1024 * 1024 });
  assert.equal(JSON.parse(reused.stdout.trim()).status, "verified_existing");
  const worker = join(assets, "runtime/node_modules/@moonshot-ai/kimi-code/dist/search-worker.mjs");
  const changed = Buffer.concat([await readFile(worker), Buffer.from("\n// integrity test\n")]);
  await writeFile(worker, changed);
  await assert.rejects(run(process.execPath, ["--use-env-proxy", entry], { env: offline, timeout: 20_000, maxBuffer: 1024 * 1024 }), error => {
    assert.match(error.stderr, /Kimi setup failed/);
    assert.doesNotMatch(error.stderr, /download|ECONNREFUSED/i);
    return true;
  });
  assert.deepEqual(await readFile(worker), changed, "Invalid existing assets must not be silently replaced");
  t.diagnostic(JSON.stringify({ target, closure: metadata.nativeClosureSha256, patch: metadata.patch.version, provisionerSha256: createHash("sha256").update(await readFile(entry)).digest("hex"), freshInstalled: true, offlineReuse: true, tamperRejected: true, modelPrompts: 0, scope: "self-contained public-layout setup component; full Paperclip tarball is a separate proof" }));
});

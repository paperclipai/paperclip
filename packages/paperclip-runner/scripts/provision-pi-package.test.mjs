import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { bundlePiProvisioner } from "./build-verified-provider-entrypoints.mjs";

test("public server tar layout carries a self-contained host provisioner and exact small inputs", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-pi-public-layout-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, "package"); const cli = join(pkg, "dist/vendor/paperclip-runner/cli");
  await mkdir(cli, { recursive: true });
  await writeFile(join(pkg, "package.json"), '{"name":"@paperclipai/server","type":"module"}');
  await writeFile(join(pkg, "dist/index.js"), 'throw new Error("do not start the server");');
  await writeFile(join(cli, "acpx-runtime-sidecar.cjs"), "// layout fixture only");
  await bundlePiProvisioner({ outputRoot: cli });
  const inputs = join(cli, "pi-provision-inputs");
  assert.deepEqual((await readdir(inputs)).sort(), ["brace-expansion.patch", "package-lock.json", "package.json", "pi-acp-runtime.ts", "pi-acp.patch", "pi-runtime-extension.ts"]);
  const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
  for (const [source, destination] of [
    ["scripts/pi-distribution/package.json", "package.json"], ["scripts/pi-distribution/package-lock.json", "package-lock.json"],
    ["../../patches/pi-acp@0.0.33.patch", "pi-acp.patch"], ["src/drivers/acpx/pi-acp-runtime.ts", "pi-acp-runtime.ts"],
    ["src/drivers/acpx/pi-runtime-extension.ts", "pi-runtime-extension.ts"],
  ]) assert.deepEqual(await readFile(resolve(packageRoot, source)), await readFile(join(inputs, destination)));
  // Exercise npm's actual package/ prefix after archive extraction, without
  // pretending this small fixture is a complete published Paperclip release.
  const archive = join(root, "server.tgz");
  execFileSync("tar", ["-czf", archive, "-C", root, "package"], { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 });
  const installed = join(root, "installed"); await mkdir(installed);
  execFileSync("tar", ["-xzf", archive, "-C", installed], { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 });
  const installedPackage = join(installed, "package"); const entry = join(installedPackage, "dist/vendor/paperclip-runner/cli/provision-pi.cjs");
  const api = createRequire(import.meta.url)(entry);
  const layout = await api.provisionPackageRoot(entry);
  assert.equal(layout.root, installedPackage);
  const installedRunner = join(installedPackage, "dist/vendor/paperclip-runner");
  assert.equal(layout.assetRoot, installedRunner);
  const network = { PATH: "/usr/bin:/bin", HTTPS_PROXY: "http://proxy.example:8080", HTTP_PROXY: "http://proxy.example:8080", NO_PROXY: "localhost", http_proxy: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", no_proxy: "localhost", SSL_CERT_FILE: "/public/ca.pem", SSL_CERT_DIR: "/public/certs", NODE_EXTRA_CA_CERTS: "/public/extra-ca.pem" };
  assert.deepEqual(api.provisionEnvironment({ ...network, HOME: "/private/home", OPENROUTER_API_KEY: "sensitive-canary", NPM_TOKEN: "sensitive-canary", NODE_OPTIONS: "--require /foreign.js", NODE_PATH: "/foreign", NODE_TLS_REJECT_UNAUTHORIZED: "0" }), { ...network, LANG: "C.UTF-8" });
  // Real, unmocked installation verifier rejects a corrupt cache before any
  // download/process. The positive full-closure proof uses real platform packs.
  await mkdir(join(installedRunner, "provider-assets/pi", `${process.platform}-${process.arch}`, "runtime"), { recursive: true });
  const deny = join(root, "deny.cjs");
  await writeFile(deny, `process.nextTick(()=>{const assert=require('node:assert/strict');assert.equal(process.env.HTTP_PROXY,'http://127.0.0.1:9');assert.equal(process.env.HTTPS_PROXY,'http://127.0.0.1:9');assert.equal(process.env.NO_PROXY,'localhost');assert.equal(process.env.http_proxy,'http://127.0.0.1:9');assert.equal(process.env.https_proxy,'http://127.0.0.1:9');assert.equal(process.env.no_proxy,'localhost');assert.equal(process.env.NODE_EXTRA_CA_CERTS,'/dev/null');for(const key of ['OPENROUTER_API_KEY','NPM_TOKEN','HOME','NODE_OPTIONS','NODE_PATH','NODE_TLS_REJECT_UNAUTHORIZED'])assert.equal(process.env[key],undefined,key);});const fail=()=>{throw Error('UNEXPECTED_NETWORK_OR_CHILD')}; globalThis.fetch=fail; for(const m of ['node:net','node:tls','node:http','node:https']){const x=require(m);for(const k of ['connect','createConnection','request','get'])if(k in x)x[k]=fail;}const c=require('node:child_process');for(const k of ['spawn','execFile','exec'])c[k]=fail;`);
  const result = spawnSync(process.execPath, ["--require", deny, entry], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "localhost", http_proxy: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", no_proxy: "localhost", NODE_EXTRA_CA_CERTS: "/dev/null", OPENROUTER_API_KEY: "sensitive-canary", NPM_TOKEN: "sensitive-canary", HOME: "/private/home", NODE_OPTIONS: "", NODE_PATH: "/foreign", NODE_TLS_REJECT_UNAUTHORIZED: "0" }, timeout: 10_000 });
  assert.ifError(result.error); assert.equal(result.status, 1); assert.match(result.stderr, /Pi setup failed/);
  assert.doesNotMatch(result.stderr, /UNEXPECTED_NETWORK_OR_CHILD|sensitive-canary/);
  assert.deepEqual(await readdir(join(installedRunner, "provider-assets/pi")), [`${process.platform}-${process.arch}`]);
});

test("explicit CLI setup passes only network settings to its real child and enables Node proxy handling", async t => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-pi-setup-environment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = join(root, "node_modules/@paperclipai/server");
  const cli = join(server, "dist/vendor/paperclip-runner/cli");
  await mkdir(cli, { recursive: true });
  await writeFile(join(server, "package.json"), JSON.stringify({ name: "@paperclipai/server", type: "module", exports: "./dist/index.js" }));
  await writeFile(join(server, "dist/index.js"), "throw Error('server must not start')");
  // A capture child models the public layout only. It cannot download or launch Pi.
  await writeFile(join(cli, "provision-pi.cjs"), `const assert=require('node:assert/strict');
    assert.deepEqual(process.execArgv,['--use-env-proxy']);
    assert.equal(process.env.HTTP_PROXY,'http://127.0.0.1:9');
    assert.equal(process.env.HTTPS_PROXY,'http://127.0.0.1:9');
    assert.equal(process.env.NO_PROXY,'localhost');assert.equal(process.env.http_proxy,'http://127.0.0.1:9');assert.equal(process.env.https_proxy,'http://127.0.0.1:9');assert.equal(process.env.no_proxy,'localhost');
    assert.equal(process.env.SSL_CERT_FILE,'/public/ca.pem');
    assert.equal(process.env.SSL_CERT_DIR,'/public/certs');
    assert.equal(process.env.NODE_EXTRA_CA_CERTS,'/dev/null');
    for(const key of ['OPENROUTER_API_KEY','NPM_TOKEN','HOME','NODE_OPTIONS','NODE_PATH','NODE_TLS_REJECT_UNAUTHORIZED']) assert.equal(process.env[key],undefined,key);
    console.log('SETUP_NETWORK_BOUNDARY_PASS');`);
  const modulePath = join(root, "runtime.mjs");
  await build({ entryPoints: [resolve(dirname(new URL(import.meta.url).pathname), "../../../cli/src/commands/runtime.ts")], outfile: modulePath, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" });
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", "const runtime=await import(process.argv[1]);await runtime.setupPiRuntime();", modulePath], {
    encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/bin:/bin", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "localhost", http_proxy: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", no_proxy: "localhost", SSL_CERT_FILE: "/public/ca.pem", SSL_CERT_DIR: "/public/certs", NODE_EXTRA_CA_CERTS: "/dev/null", OPENROUTER_API_KEY: "sensitive-canary", NPM_TOKEN: "sensitive-canary", HOME: "/private/home", NODE_PATH: "/foreign", NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SETUP_NETWORK_BOUNDARY_PASS/);
  assert.doesNotMatch(result.stdout + result.stderr, /sensitive-canary/);
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { bundlePiProvisioner } from "./build-verified-provider-entrypoints.mjs";

test("public server tar layout carries a self-contained host provisioner and exact small inputs", async t => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-pi-public-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, "package"); const cli = join(pkg, "dist/vendor/paperclip-runner/cli");
  await mkdir(cli, { recursive: true });
  await writeFile(join(pkg, "package.json"), '{"name":"@paperclipai/server","type":"module"}');
  await writeFile(join(pkg, "dist/index.js"), 'throw new Error("do not start the server");');
  await writeFile(join(cli, "acpx-runtime-sidecar.cjs"), "// layout fixture only");
  await bundlePiProvisioner({ outputRoot: cli });
  const inputs = join(cli, "pi-provision-inputs");
  assert.deepEqual((await readdir(inputs)).sort(), ["package-lock.json", "package.json", "pi-acp-runtime.ts", "pi-acp.patch", "pi-runtime-extension.ts"]);
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
  assert.equal((await api.provisionPackageRoot(entry)).root, installedPackage);
  // Real, unmocked installation verifier rejects a corrupt cache before any
  // download/process. The positive full-closure proof uses real platform packs.
  await mkdir(join(installedPackage, "provider-assets/pi", `${process.platform}-${process.arch}`, "runtime"), { recursive: true });
  const deny = join(root, "deny.cjs");
  await writeFile(deny, `const fail=()=>{throw Error('UNEXPECTED_NETWORK_OR_CHILD')}; globalThis.fetch=fail; for(const m of ['node:net','node:tls','node:http','node:https']){const x=require(m);for(const k of ['connect','createConnection','request','get'])if(k in x)x[k]=fail;}const c=require('node:child_process');for(const k of ['spawn','execFile','exec'])c[k]=fail;`);
  const result = spawnSync(process.execPath, ["--require", deny, entry], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", OPENROUTER_API_KEY: "sensitive-canary", NODE_OPTIONS: "" }, timeout: 10_000 });
  assert.ifError(result.error); assert.equal(result.status, 1); assert.match(result.stderr, /Pi setup failed/);
  assert.doesNotMatch(result.stderr, /UNEXPECTED_NETWORK_OR_CHILD|sensitive-canary/);
  assert.deepEqual(await readdir(join(installedPackage, "provider-assets/pi")), [`${process.platform}-${process.arch}`]);
});

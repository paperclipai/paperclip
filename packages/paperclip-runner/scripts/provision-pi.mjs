#!/usr/bin/env node
/** Explicit operator setup only. Never imported by npm lifecycle or agent launch. */
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { materializePiDistribution } from "./materialize-pi-distribution.mjs";
import { verifyPiInstallation } from "../src/drivers/acpx/pi-installation.ts";
import { QUALIFIED_ACPX_PROFILES } from "../src/drivers/acpx/qualified-profiles.ts";
import { PI_DISTRIBUTION_CLOSURE_SHA256 } from "../src/drivers/acpx/pi-closure-pins.ts";

export function provisionEnvironment(source = process.env) {
  const environment = { PATH: source.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" };
  for (const key of ["LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
    if (typeof source[key] === "string") environment[key] = source[key];
  }
  return environment;
}

export async function provisionPackageRoot(entrypoint) {
  const canonical = await realpath(entrypoint);
  if (canonical !== resolve(entrypoint)) throw new Error("Pi setup entrypoint must not be linked");
  if (basename(canonical) !== "provision-pi.cjs" || !(await lstat(canonical)).isFile()) throw new Error("Pi setup requires its installed entrypoint");
  const cli = dirname(canonical);
  const vendored = cli.endsWith("/dist/vendor/paperclip-runner/cli");
  if (!vendored && !cli.endsWith("/dist/cli")) throw new Error("Pi setup requires the installed runner or server layout");
  const root = resolve(cli, vendored ? "../../../.." : "../..");
  const manifest = join(root, "package.json");
  const handle = await open(manifest, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 65536n || before.nlink !== 1n) throw new Error("Pi setup package manifest is invalid");
    const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); const named = await lstat(manifest, { bigint: true });
    if (before.ino !== after.ino || before.dev !== after.dev || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || bytes.length !== Number(before.size) || named.ino !== before.ino || named.dev !== before.dev) throw new Error("Pi setup package manifest changed");
    const expected = vendored ? "@paperclipai/server" : "@paperclipai/paperclip-runner";
    if (JSON.parse(bytes.toString()).name !== expected) throw new Error("Pi setup package identity does not match its layout");
  } finally { await handle.close(); }
  return { root, manifest, cli, assetRoot: vendored ? resolve(cli, "..") : root };
}
async function verifiedInstallation(root, manifest) {
  const keys = ["PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", "PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST"];
  const previous = keys.map(key => process.env[key]);
  process.env[keys[0]] = root; process.env[keys[1]] = manifest;
  try { const installation = await verifyPiInstallation(QUALIFIED_ACPX_PROFILES.pi); const lease = await installation.openCommand(); await lease.close(); }
  finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
}
async function absent(path) { try { await lstat(path); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; } }
async function containedDirectory(root, path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory() || !path.startsWith(root + "/")) throw new Error("Pi setup asset directory escapes its package");
}
export async function provisionPi(entrypoint, checkCancelled = () => {}) {
  checkCancelled();
  const target = `${process.platform}-${process.arch}`;
  if (!Object.hasOwn(PI_DISTRIBUTION_CLOSURE_SHA256, target)) throw new Error(`Pi is not qualified for platform ${target}`);
  const { root, manifest, cli, assetRoot } = await provisionPackageRoot(entrypoint);
  const assets = join(assetRoot, "provider-assets"); const parent = join(assets, "pi");
  await containedDirectory(root, assets); await containedDirectory(root, parent);
  const lockPath = join(parent, `.setup-${target}.lock`);
  const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let lockIdentity; let temporary; let temporaryIdentity; let published; let committed = false;
  const output = join(parent, target);
  try {
    lockIdentity = await lock.stat({ bigint: true });
    checkCancelled();
    if (!(await absent(output))) {
      await verifiedInstallation(root, manifest);
      return { status: "verified_existing", target, profileDigest: QUALIFIED_ACPX_PROFILES.pi.commandDigest };
    }
    temporary = await mkdtemp(join(parent, ".setup-private-"));
    temporaryIdentity = await lstat(temporary, { bigint: true });
    const stagingRoot = join(temporary, "package"); await mkdir(stagingRoot, { mode: 0o700 });
    await writeFile(join(stagingRoot, "package.json"), JSON.stringify({ name: "@paperclipai/paperclip-runner" }), { flag: "wx", mode: 0o600 });
    const stagedOutput = join(stagingRoot, "provider-assets/pi", target);
    const inputs = join(cli, "pi-provision-inputs");
    await materializePiDistribution({ outputRoot: stagedOutput, checkCancelled, inputs: {
      lockDirectory: inputs, patchPath: join(inputs, "pi-acp.patch"),
      securityPatchPath: join(inputs, "brace-expansion.patch"),
      helperSourcePath: join(inputs, "pi-acp-runtime.ts"), extensionSourcePath: join(inputs, "pi-runtime-extension.ts"),
    } });
    await verifiedInstallation(stagingRoot, join(stagingRoot, "package.json"));
    if (!(await absent(output))) throw new Error("Pi setup destination appeared during installation; refusing replacement");
    checkCancelled();
    // mkdir is exclusive: rename(directory) would replace an empty concurrent
    // destination. Claim a private final root instead; readiness fails closed
    // until every entry is installed and the complete closure verifies.
    await mkdir(output, { mode: 0o700 });
    published = await lstat(output, { bigint: true });
    for (const name of await readdir(stagedOutput)) {
      const named = await lstat(output, { bigint: true });
      if (named.dev !== published.dev || named.ino !== published.ino || named.isSymbolicLink()) throw new Error("Pi setup output ownership changed during publication");
      await rename(join(stagedOutput, name), join(output, name));
    }
    await verifiedInstallation(root, manifest);
    checkCancelled();
    committed = true;
    return { status: "installed_verified", target, profileDigest: QUALIFIED_ACPX_PROFILES.pi.commandDigest };
  } finally {
    // Drain every cleanup even if one fails. Never remove a pre-existing or
    // replaced destination or another invocation's lock.
    const cleanup = [];
    if (published && !committed) cleanup.push((async () => {
      const named = await lstat(output, { bigint: true });
      if (named.dev !== published.dev || named.ino !== published.ino || named.isSymbolicLink()) throw new Error("Pi setup output ownership changed; refusing cleanup");
      await rm(output, { recursive: true });
    })());
    if (temporary) cleanup.push((async () => {
      const named = await lstat(temporary, { bigint: true });
      if (!temporaryIdentity || named.dev !== temporaryIdentity.dev || named.ino !== temporaryIdentity.ino || named.isSymbolicLink()) throw new Error("Pi setup staging ownership changed; refusing cleanup");
      await rm(temporary, { recursive: true });
    })());
    cleanup.push((async () => {
      try {
        lockIdentity ??= await lock.stat({ bigint: true });
        const named = await lstat(lockPath, { bigint: true });
        if (named.dev !== lockIdentity.dev || named.ino !== lockIdentity.ino) throw new Error("Pi setup lock ownership changed; refusing cleanup");
        await unlink(lockPath);
      } finally { await lock.close(); }
    })());
    const results = await Promise.allSettled(cleanup);
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Pi setup cleanup failed; inspect the package before retrying");
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length) throw new Error("Usage: paperclipai runtime setup pi (explicit host-platform installation; no model calls)");
  // Preserve the same closed network allowlist as the explicit CLI command.
  // Never forward provider keys, HOME config, NODE_OPTIONS or npm configuration.
  const environment = provisionEnvironment();
  for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, environment);
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  // Each active materializer subprocess has its original <=300s timeout. A
  // cancellation waits for that owned child before removing its files.
  const deadline = setTimeout(cancel, 900_000); deadline.unref();
  provisionPi(fileURLToPath(import.meta.url), () => { if (cancelled) throw new Error("Pi setup cancelled; no installation was admitted"); }).finally(() => {
    clearTimeout(deadline); process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
  }).then(value => console.log(JSON.stringify(value)))
    .catch(error => { console.error(`Pi setup failed: ${error.message}`); process.exitCode = 1; });
}

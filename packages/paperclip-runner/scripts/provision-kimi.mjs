#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { materializeKimiDistribution, kimiDistributionEnvironment } from "./materialize-kimi-distribution.mjs";
import { KIMI_DISTRIBUTION_CLOSURE_SHA256 } from "../src/drivers/acpx/kimi-closure-pins.ts";
import { verifyKimiInstallation } from "../src/drivers/acpx/kimi-installation.ts";
import { QUALIFIED_ACPX_PROFILES } from "../src/drivers/acpx/qualified-profiles.ts";

export function provisionEnvironment(source = process.env) {
  return { ...kimiDistributionEnvironment(source), LANG: "C.UTF-8", PATH: source.PATH ?? "/usr/bin:/bin" };
}

export async function provisionKimiPackageRoot(entrypoint) {
  const canonical = await realpath(entrypoint);
  if (canonical !== resolve(entrypoint) || basename(canonical) !== "provision-kimi.cjs" || !(await lstat(canonical)).isFile()) throw new Error("Kimi setup requires its installed entrypoint");
  const cli = dirname(canonical);
  const vendored = cli.endsWith("/dist/vendor/paperclip-runner/cli");
  if (!vendored && !cli.endsWith("/dist/cli")) throw new Error("Kimi setup requires the installed runner or server layout");
  const root = resolve(cli, vendored ? "../../../.." : "../..");
  const manifest = join(root, "package.json");
  const file = await open(manifest, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 64n * 1024n) throw new Error("Kimi setup package manifest is invalid");
    const bytes = await file.readFile(), after = await file.stat({ bigint: true }), named = await lstat(manifest, { bigint: true });
    if (bytes.length !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()) throw new Error("Kimi setup package manifest changed");
    if (JSON.parse(bytes.toString("utf8")).name !== (vendored ? "@paperclipai/server" : "@paperclipai/paperclip-runner")) throw new Error("Kimi setup package identity does not match its layout");
  } finally { await file.close(); }
  return { root, manifest, cli, assetRoot: vendored ? resolve(cli, "..") : root };
}

async function verifyInstallation(root, manifest) {
  const keys = ["PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", "PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST"], previous = keys.map(key => process.env[key]);
  process.env[keys[0]] = root; process.env[keys[1]] = manifest;
  try {
    const installation = await verifyKimiInstallation(QUALIFIED_ACPX_PROFILES.kimi);
    const lease = await installation.openCommand();
    await lease.close();
  } finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
}

async function absent(path) { try { await lstat(path); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; } }
async function containedDirectory(root, path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory() || !path.startsWith(root + "/")) throw new Error("Kimi setup asset directory escapes its package");
}

export async function provisionKimi(entrypoint, checkCancelled = () => {}, signal) {
  checkCancelled(); signal?.throwIfAborted();
  const target = `${process.platform}-${process.arch}`;
  if (!Object.hasOwn(KIMI_DISTRIBUTION_CLOSURE_SHA256, target)) throw new Error(`Kimi is not supported on ${target}`);
  const { root, manifest, cli, assetRoot } = await provisionKimiPackageRoot(entrypoint);
  const assets = join(assetRoot, "provider-assets"), parent = join(assets, "kimi");
  await containedDirectory(root, assets); await containedDirectory(root, parent);
  const lockPath = join(parent, `.setup-${target}.lock`);
  const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let lockIdentity, temporary, temporaryIdentity, published, committed = false;
  const output = join(parent, target);
  try {
    lockIdentity = await lock.stat({ bigint: true });
    checkCancelled();
    if (!(await absent(output))) {
      await verifyInstallation(root, manifest);
      return { status: "verified_existing", target, profileDigest: QUALIFIED_ACPX_PROFILES.kimi.commandDigest };
    }
    temporary = await mkdtemp(join(parent, ".setup-private-")); temporaryIdentity = await lstat(temporary, { bigint: true });
    const stagingRoot = join(temporary, "package"); await mkdir(stagingRoot, { mode: 0o700 });
    await writeFile(join(stagingRoot, "package.json"), JSON.stringify({ name: "@paperclipai/paperclip-runner" }), { flag: "wx", mode: 0o600 });
    const stagedOutput = join(stagingRoot, "provider-assets/kimi", target);
    await materializeKimiDistribution({ outputRoot: stagedOutput, lockDirectory: join(cli, "kimi-provision-inputs"), checkCancelled, signal });
    await verifyInstallation(stagingRoot, join(stagingRoot, "package.json"));
    if (!(await absent(output))) throw new Error("Kimi setup destination appeared during installation; refusing replacement");
    checkCancelled();
    await mkdir(output, { mode: 0o700 }); published = await lstat(output, { bigint: true });
    for (const name of await readdir(stagedOutput)) {
      const named = await lstat(output, { bigint: true });
      if (named.dev !== published.dev || named.ino !== published.ino || named.isSymbolicLink()) throw new Error("Kimi setup output ownership changed during publication");
      await rename(join(stagedOutput, name), join(output, name));
    }
    await verifyInstallation(root, manifest);
    checkCancelled(); committed = true;
    return { status: "installed_verified", target, profileDigest: QUALIFIED_ACPX_PROFILES.kimi.commandDigest };
  } finally {
    const cleanup = [];
    if (published && !committed) cleanup.push((async () => {
      const named = await lstat(output, { bigint: true });
      if (named.dev !== published.dev || named.ino !== published.ino || named.isSymbolicLink()) throw new Error("Kimi setup output ownership changed; refusing cleanup");
      await rm(output, { recursive: true });
    })());
    if (temporary) cleanup.push((async () => {
      const named = await lstat(temporary, { bigint: true });
      if (!temporaryIdentity || named.dev !== temporaryIdentity.dev || named.ino !== temporaryIdentity.ino || named.isSymbolicLink()) throw new Error("Kimi setup staging ownership changed; refusing cleanup");
      await rm(temporary, { recursive: true });
    })());
    cleanup.push((async () => {
      try {
        lockIdentity ??= await lock.stat({ bigint: true }); const named = await lstat(lockPath, { bigint: true });
        if (named.dev !== lockIdentity.dev || named.ino !== lockIdentity.ino) throw new Error("Kimi setup lock ownership changed; refusing cleanup");
        await unlink(lockPath);
      } finally { await lock.close(); }
    })());
    const results = await Promise.allSettled(cleanup), failed = results.filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Kimi setup cleanup failed; inspect the package before retrying");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new Error("Usage: paperclipai runtime setup kimi (explicit host installation; no model calls)");
  const environment = provisionEnvironment();
  for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, environment);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  const deadline = setTimeout(cancel, 900_000); deadline.unref();
  provisionKimi(fileURLToPath(import.meta.url), () => { if (controller.signal.aborted) throw new Error("Kimi setup cancelled; no installation was admitted"); }, controller.signal).finally(() => {
    clearTimeout(deadline); process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
  }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(`Kimi setup failed: ${error.message}`); process.exitCode = 1; });
}

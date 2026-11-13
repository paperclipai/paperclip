import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { KIMI_DISTRIBUTION_CLOSURE_SHA256, KIMI_DISTRIBUTION_LOCK_SHA256, KIMI_NODE_DISTRIBUTIONS, KIMI_NODE_VERSION, KIMI_RUNTIME_VERSION } from "../src/drivers/acpx/kimi-closure-pins.ts";
import { inventoryKimiRuntimeFiles, kimiRuntimeClosureDigest } from "../src/drivers/acpx/kimi-runtime-files.ts";
import { patchKimiRuntime } from "./patch-kimi-runtime.mjs";

const run = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const KIMI_DISTRIBUTION_ENTRYPOINT = "node_modules/@moonshot-ai/kimi-code/dist/main.mjs";

export async function runKimiBuildCommand(command, args, options, checkCancelled = () => {}, signal) {
  checkCancelled(); signal?.throwIfAborted();
  const pending = run(command, args, { ...options, signal, killSignal: "SIGKILL" });
  const closed = new Promise(resolve => pending.child.once("close", resolve));
  try {
    const result = await pending;
    checkCancelled(); signal?.throwIfAborted();
    return result;
  } finally { await closed; }
}

export function kimiDistributionInstallCommand() {
  return ["ci", "--ignore-scripts", "--omit=optional", "--omit=dev", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", "--userconfig=.npmrc", "--globalconfig=.npmrc-global"];
}

export function kimiDistributionEnvironment(source = process.env) {
  return Object.fromEntries(["PATH", "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"].flatMap(key => typeof source[key] === "string" ? [[key, source[key]]] : []));
}

export async function verifyLockedKimiPackageGraph(root, lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages || lock.packages[""]?.dependencies?.["@moonshot-ai/kimi-code"] !== KIMI_RUNTIME_VERSION) throw new Error("Kimi distribution lock is invalid");
  let packages = 0;
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (!path.startsWith("node_modules/") || /[\\\u0000-\u001f\u007f]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..") || entry.link || typeof entry.version !== "string" || !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved ?? "") || !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity ?? "")) throw new Error("Kimi distribution lock contains an unpinned package");
    if (entry.optional === true) {
      try { await lstat(join(root, path)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      throw new Error("Kimi headless distribution unexpectedly installed an optional TUI dependency");
    }
    const file = join(root, path, "package.json");
    if (await realpath(file) !== file || !(await lstat(file)).isFile()) throw new Error("Kimi distribution package metadata is not a regular file");
    const actual = JSON.parse(await readFile(file, "utf8"));
    if (actual.version !== entry.version) throw new Error(`Kimi distribution package differs from its lock: ${path}`);
    packages++;
  }
  return packages;
}

export function assertKimiNodeSystemDependencies(listing, platform) {
  for (const line of listing.split("\n").map(value => value.trim()).filter(Boolean)) {
    if (platform === "darwin") {
      if (line.endsWith(":")) continue;
      if (!line.startsWith("/usr/lib/") && !line.startsWith("/System/Library/")) throw new Error("Kimi Node depends on an unbundled library");
    } else if (!line.startsWith("linux-vdso.so.") && !/^(?:[^\s]+ => )?\/(?:usr\/)?lib(?:64)?\//.test(line)) throw new Error("Kimi Node depends on an unbundled library");
  }
}

async function nodeDistribution(staging, target, archivePath, environment, runOwned, signal) {
  const pin = KIMI_NODE_DISTRIBUTIONS[target];
  if (!pin) throw new Error(`Kimi distribution target is unsupported: ${target}`);
  let bytes;
  if (archivePath) bytes = await readFile(archivePath);
  else {
    const timeout = AbortSignal.timeout(60_000);
    const response = await fetch(`https://nodejs.org/dist/v${KIMI_NODE_VERSION}/node-v${KIMI_NODE_VERSION}-${target}.tar.gz`, { redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok || !response.body) throw new Error("Pinned Kimi Node download failed");
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 128 * 1024 * 1024) throw new Error("Kimi Node archive exceeds its bound");
      chunks.push(Buffer.from(chunk));
    }
    bytes = Buffer.concat(chunks);
  }
  if (bytes.length > 128 * 1024 * 1024 || hash(bytes) !== pin.archiveSha256) throw new Error("Kimi Node archive does not match its release pin");
  const archive = join(staging, `${target}.tar.gz`); await writeFile(archive, bytes);
  const output = join(staging, `node-${target}`); await mkdir(output);
  await runOwned("tar", ["-xzf", archive, "-C", output, "--strip-components=1", `node-v${KIMI_NODE_VERSION}-${target}/bin/node`, `node-v${KIMI_NODE_VERSION}-${target}/lib/node_modules/npm`], { env: environment, timeout: 30_000 });
  const executable = join(output, "bin/node");
  if (hash(await readFile(executable)) !== pin.executableSha256 || (await lstat(executable)).size !== pin.executableSize) throw new Error("Kimi Node executable does not match its target pin");
  const npm = join(output, "lib/node_modules/npm/bin/npm-cli.js");
  if (JSON.parse(await readFile(join(output, "lib/node_modules/npm/package.json"), "utf8")).version !== "11.19.0") throw new Error("Kimi Node archive has an unexpected npm version");
  return { executable, npm };
}

async function removePackageManagerLinks(root) {
  const visit = async directory => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name), stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        if (dirname(path).endsWith("/node_modules/.bin")) await unlink(path);
        else throw new Error("Kimi package payload contains an unsupported symbolic link");
      } else if (stat.isDirectory()) await visit(path);
      else if (!stat.isFile()) throw new Error("Kimi package payload contains a non-file resource");
    }
  };
  await visit(root);
  await rm(join(root, "node_modules/.package-lock.json"), { force: true });
}

export async function buildKimiDistribution({ outputRoot, target = `${process.platform}-${process.arch}`, lockDirectory = join(packageRoot, "scripts/kimi-distribution"), nodeArchives = {}, checkCancelled = () => {}, signal }) {
  checkCancelled(); signal?.throwIfAborted();
  if (typeof outputRoot !== "string" || !isAbsolute(outputRoot)) throw new Error("Kimi distribution output must be absolute");
  const output = resolve(outputRoot);
  if (["/", packageRoot, repositoryRoot].includes(output)) throw new Error("Refusing unsafe Kimi distribution output");
  if (!Object.hasOwn(KIMI_NODE_DISTRIBUTIONS, target)) throw new Error("Kimi distribution target is unsupported");
  const host = `${process.platform}-${process.arch}`;
  if (!Object.hasOwn(KIMI_NODE_DISTRIBUTIONS, host)) throw new Error("Kimi distribution build host is unsupported");
  try { await lstat(output); throw new Error("Kimi distribution output already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const lockBytes = await readFile(join(lockDirectory, "package-lock.json"));
  if (hash(lockBytes) !== KIMI_DISTRIBUTION_LOCK_SHA256) throw new Error("Kimi distribution lock differs from its source pin");
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(await realpath(dirname(output)), ".paperclip-kimi-distribution-"));
  const environment = kimiDistributionEnvironment();
  const runOwned = (command, args, options) => runKimiBuildCommand(command, args, options, checkCancelled, signal);
  const runtime = join(staging, "runtime");
  try {
    const buildHome = join(staging, "build-home"); await mkdir(buildHome); environment.HOME = buildHome;
    const installedNode = await nodeDistribution(staging, target, nodeArchives[target], environment, runOwned, signal);
    const buildNode = host === target ? installedNode : await nodeDistribution(staging, host, nodeArchives[host], environment, runOwned, signal);
    if ((await runOwned(buildNode.executable, ["--version"], { env: {}, timeout: 10_000 })).stdout.trim() !== `v${KIMI_NODE_VERSION}`) throw new Error("Kimi distribution build Node cannot execute");
    await mkdir(runtime);
    for (const name of ["package.json", "package-lock.json"]) await copyFile(join(lockDirectory, name), join(runtime, name));
    await writeFile(join(runtime, ".npmrc"), "registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n");
    await writeFile(join(runtime, ".npmrc-global"), "");
    await runOwned(buildNode.executable, [buildNode.npm, ...kimiDistributionInstallCommand()], { cwd: runtime, env: environment, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
    if (!(await readFile(join(runtime, "package-lock.json"))).equals(lockBytes)) throw new Error("Kimi installation changed its committed lock");
    const packageCount = await verifyLockedKimiPackageGraph(runtime, JSON.parse(lockBytes.toString("utf8")));
    const patch = await patchKimiRuntime(join(runtime, KIMI_DISTRIBUTION_ENTRYPOINT));
    await mkdir(join(runtime, "node/bin"), { recursive: true });
    await copyFile(installedNode.executable, join(runtime, "node/bin/node")); await chmod(join(runtime, "node/bin/node"), 0o755);
    if (host === target) {
      const listing = process.platform === "darwin"
        ? await runOwned("/usr/bin/otool", ["-L", join(runtime, "node/bin/node")], { env: {}, timeout: 10_000 })
        : await runOwned("ldd", [join(runtime, "node/bin/node")], { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 });
      assertKimiNodeSystemDependencies(listing.stdout, process.platform);
      if ((await runOwned(join(runtime, "node/bin/node"), ["--version"], { env: {}, timeout: 10_000 })).stdout.trim() !== `v${KIMI_NODE_VERSION}`) throw new Error("Kimi Node cannot execute after relocation");
    }
    await removePackageManagerLinks(runtime);
    const entries = await inventoryKimiRuntimeFiles(runtime);
    const closure = kimiRuntimeClosureDigest(entries);
    const metadata = { schema: "paperclip.kimi-distribution.v1", version: KIMI_RUNTIME_VERSION, target, nodeVersion: KIMI_NODE_VERSION, runtimeRoot: "runtime", entrypoint: KIMI_DISTRIBUTION_ENTRYPOINT, lockSha256: KIMI_DISTRIBUTION_LOCK_SHA256, patch, packageCount, nativeClosureSha256: closure };
    await writeFile(join(staging, "native-closure.json"), `${JSON.stringify({ entries })}\n`);
    await writeFile(join(staging, "kimi-distribution.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    for (const name of await readdir(staging)) if (!["runtime", "native-closure.json", "kimi-distribution.json"].includes(name)) await rm(join(staging, name), { recursive: true, force: true });
    checkCancelled();
    await rename(staging, output);
    return { outputRoot: output, runtimeRoot: join(output, "runtime"), version: KIMI_RUNTIME_VERSION, closureDigest: `sha256:${closure}`, metadata };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

export async function materializeKimiDistribution(options) {
  if (typeof options.outputRoot !== "string" || !isAbsolute(options.outputRoot)) throw new Error("Kimi distribution output must be absolute");
  const output = resolve(options.outputRoot);
  if (["/", packageRoot, repositoryRoot].includes(output)) throw new Error("Refusing unsafe Kimi distribution output");
  const target = options.target ?? `${process.platform}-${process.arch}`;
  if (!Object.hasOwn(KIMI_DISTRIBUTION_CLOSURE_SHA256, target)) throw new Error("Kimi distribution target is unsupported");
  try { await lstat(output); throw new Error("Kimi distribution output already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(dirname(output), { recursive: true });
  const parent = await realpath(dirname(output));
  const temporary = await mkdtemp(join(parent, ".paperclip-kimi-admission-"));
  const candidate = join(temporary, "candidate");
  try {
    const result = await buildKimiDistribution({ ...options, outputRoot: candidate });
    if (result.metadata.nativeClosureSha256 !== KIMI_DISTRIBUTION_CLOSURE_SHA256[target]) throw new Error("Kimi native closure differs from its trusted target pin");
    try { await lstat(options.outputRoot); throw new Error("Kimi distribution output already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(candidate, options.outputRoot);
    return { ...result, outputRoot: options.outputRoot, runtimeRoot: join(options.outputRoot, "runtime") };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (import.meta.url.endsWith("/materialize-kimi-distribution.mjs") && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("Usage: node scripts/materialize-kimi-distribution.mjs /absolute/output-directory");
  materializeKimiDistribution({ outputRoot: args[0] }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}

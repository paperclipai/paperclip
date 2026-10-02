import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PI_DISTRIBUTION_CLOSURE_SHA256 } from "../src/drivers/acpx/pi-closure-pins.ts";
import { PI_NODE_DISTRIBUTIONS, PI_NODE_VERSION } from "../src/drivers/acpx/pi-node-pins.ts";
import { buildNodeStartupTimeout } from "./build-node-startup-timeout.mjs";
import { QUALIFIED_ACPX_PROFILES } from "../src/drivers/acpx/qualified-profiles.ts";
import { inventoryPiRuntimeFiles, verifyPiRuntimeManifest } from "../src/drivers/acpx/pi-verified-runtime.ts";

const run = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const lockDirectory = join(packageRoot, "scripts/pi-distribution");
const patchPath = join(workspaceRoot, "patches/pi-acp@0.0.33.patch");
const supportedTargets = new Set(["darwin-arm64", "darwin-x64", "linux-x64"]);
export const PI_DISTRIBUTION_PINS = Object.freeze({
  wrapper: "0.0.33", runtime: "1.0.0", sdk: "0.26.0", zod: "3.25.76", nodeVersion: PI_NODE_VERSION, undici: "8.10.2", nodeBundledUndici: "7.29.1",
  wrapperSha256: "8ef777e9e6a3cef37775bab2b800e4931330c23a0b151ce07fdc5b943f28435d",
  helperSha256: "2191b1e5f281d24508ec7eaff39011ee863a8a70bf54f4aa0490ad0172b323da",
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** npm ci preserves the complete Pi 1.0.0 published shrinkwrap unchanged. */
export function piDistributionInstallCommand() {
  return ["ci", "--ignore-scripts", "--include=optional", "--omit=dev", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", "--userconfig=.npmrc", "--globalconfig=.npmrc-global"];
}

function supports(list, current) {
  return !Array.isArray(list) || (list.includes(current) || !list.some((value) => !value.startsWith("!"))) && !list.includes(`!${current}`);
}

/** Prove installed package versions and the complete published Pi graph. */
export async function verifyLockedPiPackageGraph(root, lock, target = { platform: process.platform, architecture: process.arch }) {
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") throw new Error("Pi distribution lock is invalid");
  let verified = 0;
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (!path.startsWith("node_modules/") || path.split("/").some((part) => part === ".." || part === "." || !part) || path.includes("\\") || entry.link || typeof entry.version !== "string" || !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved ?? "") || !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity ?? "")) throw new Error("Pi distribution lock contains an unpinned package");
    const compatible = supports(entry.os, target.platform) && supports(entry.cpu, target.architecture);
    let metadata;
    try { metadata = JSON.parse(await readFile(join(root, path, "package.json"), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT" && entry.optional === true && !compatible) continue;
      throw new Error(`Pi distribution is missing locked package ${path}`);
    }
    if (metadata.version !== entry.version) throw new Error(`Pi distribution package differs from its lock: ${path}`);
    verified++;
  }
  const piPath = "node_modules/@earendil-works/pi-coding-agent";
  const shrinkwrap = JSON.parse(await readFile(join(root, piPath, "npm-shrinkwrap.json"), "utf8"));
  if (shrinkwrap.version !== PI_DISTRIBUTION_PINS.runtime || shrinkwrap.lockfileVersion !== 3) throw new Error("Pi upstream shrinkwrap is missing or changed");
  for (const [path, entry] of Object.entries(shrinkwrap.packages)) {
    if (!path) continue;
    const pinned = lock.packages[`${piPath}/${path}`];
    if (!pinned || pinned.version !== entry.version || (entry.integrity !== undefined && pinned.integrity !== entry.integrity) || pinned.resolved !== entry.resolved) throw new Error(`Pi distribution dropped or changed shrinkwrapped package ${path}`);
  }
  return verified;
}

/** Only OS libraries may remain outside the inventoried Node executable. */
export function assertPiNodeSystemDependencies(listing, platform) {
  const lines = listing.split("\n").map((line) => line.trim()).filter(Boolean);
  if (platform === "darwin") {
    for (const line of lines.slice(1)) {
      const path = line.split(" (", 1)[0];
      if (!path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/")) throw new Error("Pi Node requires an unbundled non-system library");
    }
    if (lines.length < 2) throw new Error("Pi Node dependency inspection is empty");
  } else {
    if (listing.includes("not found")) throw new Error("Pi Node requires a missing system library");
    for (const line of lines) {
      if (line.startsWith("linux-vdso.") || line === "statically linked") continue;
      const path = line.includes(" => ") ? line.split(" => ")[1].split(" ")[0] : line.split(" ")[0];
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (!/^\/(?:usr\/)?lib(?:64)?\//.test(path) || !/^(?:lib(?:c|m|dl|pthread|gcc_s|stdc\+\+|rt|atomic)\.so(?:\.[0-9]+)*|ld-linux[^/]*\.so(?:\.[0-9]+)*)$/.test(name)) throw new Error("Pi Node requires an unbundled non-system library");
    }
    if (!lines.length) throw new Error("Pi Node dependency inspection is empty");
  }
}

export async function writePiDistributionManifest(runtimeRoot) {
  const manifest = {
    schema: "paperclip.pi-runtime-files.v1",
    node: "node/bin/node",
    piEntrypoint: "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    extension: "extensions/paperclip.js",
    wrapperEntrypoint: "node_modules/pi-acp/dist/index.js",
    files: await inventoryPiRuntimeFiles(runtimeRoot),
  };
  const verified = await verifyPiRuntimeManifest(runtimeRoot, manifest);
  return { manifest, ...verified };
}

export function piDistributionBootstrapSource() {
  return [
      'const path=require("node:path");',
      'process.env.PAPERCLIP_PI_NODE_EXECUTABLE=path.join(__dirname,"node/bin/node");',
      'process.env.PAPERCLIP_PI_ENTRYPOINT=path.join(__dirname,"node_modules/@earendil-works/pi-coding-agent/dist/cli.js");',
      'process.env.PAPERCLIP_PI_EXTENSION_PATH=path.join(__dirname,"extensions/paperclip.js");',
      'process.env.PAPERCLIP_PI_MODULE_GUARD_PATH=path.join(__dirname,".paperclip-native-module-guard.cjs");',
      'const protectedRoots=JSON.parse(process.env.PAPERCLIP_PI_PROTECTED_ROOTS??"[]");if(!Array.isArray(protectedRoots))throw new Error("Invalid Pi protected roots");',
      'process.env.PAPERCLIP_PI_PROTECTED_ROOTS=JSON.stringify([...protectedRoots,__dirname]);',
      'import(require("node:url").pathToFileURL(path.join(__dirname,"node_modules/pi-acp/dist/index.js")).href).catch(()=>{process.exitCode=1;});',
      '',
  ].join("\n");
}

/** The already hash-verified Node archive also pins setup's package manager. */
export async function resolvePiBundledNpm(nodeRoot) {
  const npmRoot = join(nodeRoot, "lib/node_modules/npm");
  const manifest = join(npmRoot, "package.json");
  const entry = join(npmRoot, "bin/npm-cli.js");
  for (const path of [manifest, entry]) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(path) !== path) throw new Error("Pinned Pi npm has an invalid archive entry");
  }
  if (JSON.parse(await readFile(manifest, "utf8")).version !== "11.19.0") throw new Error("Pinned Pi Node archive has an unexpected npm version");
  return entry;
}

/** Build on the target platform. No lifecycle scripts, model requests, or auth. */
export async function materializePiDistribution({ outputRoot, nodeExecutable, npmExecutable = "npm", inputs, checkCancelled = () => {} }) {
  // Cancellation is observed between bounded subprocesses. A setup signal must
  // not abandon an npm/tar child while it still owns staging files.
  const runOwned = async (...args) => { checkCancelled(); const result = await run(...args); checkCancelled(); return result; };
  checkCancelled();
  const inputLockDirectory = inputs?.lockDirectory ?? lockDirectory;
  const inputPatchPath = inputs?.patchPath ?? patchPath;
  const helperSourcePath = inputs?.helperSourcePath ?? join(packageRoot, "src/drivers/acpx/pi-acp-runtime.ts");
  const extensionSourcePath = inputs?.extensionSourcePath ?? join(packageRoot, "src/drivers/acpx/pi-runtime-extension.ts");
  if (typeof outputRoot !== "string" || !outputRoot || !isAbsolute(outputRoot)) throw new Error("Pi distribution output must be absolute");
  const output = resolve(outputRoot);
  if (["/", workspaceRoot, packageRoot].includes(output)) throw new Error("Refusing unsafe Pi distribution output");
  if (!supportedTargets.has(`${process.platform}-${process.arch}`)) throw new Error("Pi distribution target is unsupported");
  try { await lstat(output); throw new Error("Pi distribution output already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(await realpath(dirname(output)), ".paperclip-pi-distribution-"));
  const runtimeRoot = join(staging, "runtime");
  try {
    const target = `${process.platform}-${process.arch}`;
    const nodePin = PI_NODE_DISTRIBUTIONS[target];
    let node;
    let bundledNpm;
    if (nodeExecutable) node = await realpath(nodeExecutable);
    else {
      const archiveName = `node-v${PI_NODE_VERSION}-${target}.tar.gz`;
      const response = await fetch(`https://nodejs.org/dist/v${PI_NODE_VERSION}/${archiveName}`, { redirect: "error", signal: AbortSignal.timeout(60_000) });
      if (!response.ok || !response.body) throw new Error("Pinned Pi Node download failed");
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length; if (length > 128 * 1024 * 1024) throw new Error("Pi Node archive exceeds its bound");
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      if (hash(bytes) !== nodePin.archiveSha256) throw new Error("Pi Node archive does not match its release pin");
      const archivePath = join(staging, archiveName); await writeFile(archivePath, bytes);
      const nodeRoot = join(staging, "node-extract"); await mkdir(nodeRoot);
      await runOwned("tar", ["-xzf", archivePath, "-C", nodeRoot, "--strip-components=1", `node-v${PI_NODE_VERSION}-${target}/bin/node`, `node-v${PI_NODE_VERSION}-${target}/lib/node_modules/npm`], { timeout: 30_000 });
      node = join(nodeRoot, "bin/node");
      bundledNpm = await resolvePiBundledNpm(nodeRoot);
    }
    if (hash(await readFile(node)) !== nodePin.executableSha256 || (await lstat(node)).size !== nodePin.executableSize) throw new Error("Pi Node executable does not match its target release pin");
    const version = (await runOwned(node, ["--version"], { env: {}, timeout: buildNodeStartupTimeout() })).stdout.trim();
    if (version !== `v${PI_NODE_VERSION}`) throw new Error("Pi distribution requires exact pinned Node version");
    if ((await runOwned(node, ["-p", "process.versions.undici"], { env: {}, timeout: buildNodeStartupTimeout() })).stdout.trim() !== PI_DISTRIBUTION_PINS.nodeBundledUndici) throw new Error("Pi Node bundled Undici differs from its reviewed security pin");
    await mkdir(runtimeRoot);
    await Promise.all(["package.json", "package-lock.json"].map((name) => copyFile(join(inputLockDirectory, name), join(runtimeRoot, name))));
    await writeFile(join(runtimeRoot, ".npmrc"), "registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n");
    await writeFile(join(runtimeRoot, ".npmrc-global"), "");
    const buildHome = join(staging, "build-home"); await mkdir(buildHome);
    // Do not inherit NPM_TOKEN, npm_config_*, NODE_OPTIONS, provider keys or user
    // .npmrc. Public registry downloads need no private application credential.
    const environment = Object.fromEntries(["PATH", "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"].flatMap((key) => typeof process.env[key] === "string" ? [[key, process.env[key]]] : []));
    environment.HOME = buildHome;
    // npm 10 prunes non-host packages bundled by upstream Pi, unlike the npm
    // 11.19.0 used to qualify this complete closure. Public setup must use the
    // npm pinned by the verified Node archive, never whichever npm is on PATH.
    await runOwned(bundledNpm ? node : npmExecutable, [...(bundledNpm ? [bundledNpm] : []), ...piDistributionInstallCommand()], { cwd: runtimeRoot, env: environment, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
    const installedLockBytes = await readFile(join(runtimeRoot, "package-lock.json"));
    if (!installedLockBytes.equals(await readFile(join(inputLockDirectory, "package-lock.json")))) throw new Error("Pi installation changed its committed lock");
    const lock = JSON.parse(installedLockBytes.toString("utf8"));
    const packageCount = await verifyLockedPiPackageGraph(runtimeRoot, lock);
    const wrapper = join(runtimeRoot, "node_modules/pi-acp");
    await runOwned("git", ["apply", "--check", inputPatchPath], { cwd: wrapper, env: environment, timeout: 10_000 });
    await runOwned("git", ["apply", inputPatchPath], { cwd: wrapper, env: environment, timeout: 10_000 });
    const [wrapperBytes, helperBytes, helperSource] = await Promise.all([
      readFile(join(wrapper, "dist/index.js")), readFile(join(wrapper, "dist/paperclip-runtime.js")),
      readFile(helperSourcePath, "utf8"),
    ]);
    // Installed CLI users may run another supported Node patch. Generate the
    // exact pinned closure with its verified Node, not the host's TS stripper.
    const stripPinnedSource = async (path, source) => inputs
      ? (await runOwned(node, ["--input-type=module", "-e", 'import {readFileSync} from "node:fs"; import {stripTypeScriptTypes} from "node:module"; process.stdout.write(stripTypeScriptTypes(readFileSync(process.argv[1],"utf8")));', path], { env: {}, timeout: buildNodeStartupTimeout(), maxBuffer: 4 * 1024 * 1024 })).stdout
      : stripTypeScriptTypes(source);
    const stripped = (await stripPinnedSource(helperSourcePath, helperSource)).split("\n").map((line) => line.trimEnd()).join("\n");
    if (hash(wrapperBytes) !== PI_DISTRIBUTION_PINS.wrapperSha256 || hash(helperBytes) !== PI_DISTRIBUTION_PINS.helperSha256 || helperBytes.toString("utf8") !== stripped) throw new Error("Pi wrapper patch does not match its qualified source");
    await mkdir(join(runtimeRoot, "extensions"));
    await writeFile(join(runtimeRoot, "extensions/paperclip.js"), (await stripPinnedSource(extensionSourcePath, await readFile(extensionSourcePath, "utf8"))).replace('from "./pi-acp-runtime.js"', 'from "../node_modules/pi-acp/dist/paperclip-runtime.js"'));
    await mkdir(join(runtimeRoot, "node/bin"), { recursive: true });
    const copiedNode = join(runtimeRoot, "node/bin/node");
    await copyFile(node, copiedNode); await chmod(copiedNode, 0o755);
    const dependencyListing = process.platform === "darwin"
      ? (await runOwned("/usr/bin/otool", ["-L", copiedNode], { env: {}, timeout: 10_000 })).stdout
      : (await runOwned("ldd", [copiedNode], { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 })).stdout;
    assertPiNodeSystemDependencies(dependencyListing, process.platform);
    if ((await runOwned(copiedNode, ["--version"], { env: {}, timeout: buildNodeStartupTimeout() })).stdout.trim() !== version) throw new Error("Copied Pi Node cannot execute after relocation");
    await rm(buildHome, { recursive: true });
    // npm-generated .bin links and hidden lock metadata are not package payload
    // files. No launch uses PATH; excluding them makes the closure regular-only.
    for (const file of await inventoryPiRuntimeFiles(runtimeRoot)) {
      if (file.kind === "symlink") {
        if (!/(?:^|\/)node_modules\/\.bin\/[^/]+$/.test(file.path)) throw new Error("Pi package payload contains an unsupported symbolic link");
        await unlink(join(runtimeRoot, file.path));
      }
    }
    await rm(join(runtimeRoot, "node_modules/.package-lock.json"), { force: true });
    await writeFile(join(runtimeRoot, "pi-entry.cjs"), piDistributionBootstrapSource());
    for (const item of await readdir(staging)) if (item !== "runtime") await rm(join(staging, item), { recursive: true, force: true });
    const { manifest, manifestDigest } = await writePiDistributionManifest(runtimeRoot);
    const entries = await Promise.all(manifest.files.map(async (file) => {
      if (file.kind !== "file") throw new Error("Pi native closure must contain regular files only");
      const stat = await lstat(join(runtimeRoot, file.path));
      return { path: file.path, sha256: file.sha256.slice("sha256:".length), size: stat.size, executable: Boolean(stat.mode & 0o111) };
    }));
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const nativeClosureSha256 = hash(JSON.stringify(entries));
    if (nativeClosureSha256 !== PI_DISTRIBUTION_CLOSURE_SHA256[target]) throw new Error("Pi native closure differs from its trusted target pin");
    await writeFile(join(staging, "native-closure.json"), `${JSON.stringify({ entries })}\n`);
    const metadata = {
      schema: "paperclip.pi-distribution.v1", pins: PI_DISTRIBUTION_PINS,
      target: { platform: process.platform, architecture: process.arch, nodeVersion: version.slice(1) },
      packageCount, lockSha256: hash(await readFile(join(runtimeRoot, "package-lock.json"))), manifestDigest,
      runtimeRoot: "runtime", nativeClosureSha256, manifest,
    };
    await writeFile(join(staging, "pi-distribution.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    checkCancelled();
    await rename(staging, output);
    const finalRoot = join(output, "runtime");
    const binding = await verifyPiRuntimeManifest(finalRoot, manifest);
    return {
      version: PI_DISTRIBUTION_PINS.runtime,
      profileDigest: QUALIFIED_ACPX_PROFILES.pi.commandDigest,
      closureDigest: `sha256:${nativeClosureSha256}`,
      outputRoot: output, runtimeRoot: finalRoot, manifestPath: join(output, "pi-distribution.json"), metadata, ...binding,
    };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

if (import.meta.url.endsWith("/materialize-pi-distribution.mjs") && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const outputArgs = args.filter((arg) => !arg.startsWith("--node="));
  const nodeArgs = args.filter((arg) => arg.startsWith("--node="));
  if (outputArgs.length !== 1 || nodeArgs.length > 1) throw new Error("Usage: node scripts/materialize-pi-distribution.mjs /absolute/output-directory [--node=/absolute/portable-node]");
  materializePiDistribution({ outputRoot: outputArgs[0], ...(nodeArgs.length ? { nodeExecutable: nodeArgs[0].slice("--node=".length) } : {}) }).then(result => {
    process.stdout.write(`${JSON.stringify({ outputRoot: result.outputRoot, manifestPath: result.manifestPath, manifestDigest: result.manifestDigest, packageCount: result.metadata.packageCount })}\n`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

// Usage: node packages/paperclip-runner/scripts/stage-release-runner-binaries.mjs MANIFEST.json
// Manifest: {sourceRevision, platforms: {"darwin-arm64": {path, sha256}, ...}, remoteProviderPack: {path, sha256}}.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerBinaryTarget } from "../src/live/runner-binary.ts";
import { verifyReleaseProviderPack } from "./release-provider-pack.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function releaseRunnerTargets(contract) {
  const supported = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
  if (!contract || contract.schema !== "paperclip.runner.release-targets.v1"
    || Object.keys(contract).sort().join() !== "schema,targets"
    || !Array.isArray(contract.targets)
    || JSON.stringify([...contract.targets].sort()) !== JSON.stringify([...supported].sort())) {
    throw Error("Unknown release daemon target contract");
  }
  return Object.freeze([...contract.targets]);
}
export const RELEASE_RUNNER_TARGETS = releaseRunnerTargets(JSON.parse(
  readFileSync(new URL("../release-runner-targets.json", import.meta.url), "utf8"),
));
export const RELEASE_PROVIDER_PACK_TARGETS = Object.freeze(["linux-x64", "linux-arm64"]);
const required = RELEASE_RUNNER_TARGETS;
const digest = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");
function regularFile(path, maximumSize) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximumSize
    || realpathSync(path) !== resolve(path)) throw Error("Release artifact must be a bounded canonical regular file");
  return readFileSync(path);
}

async function metadataContract() {
  const { PAPERCLIP_RUNNER_BUILD_METADATA } = await import("../dist/evals/build-metadata.js");
  const { parsePaperclipRunnerdBuildMetadata } = await import("../dist/evals/runnerd-artifact.js");
  return metadata => verifyReleaseRunnerMetadata(parsePaperclipRunnerdBuildMetadata(metadata), PAPERCLIP_RUNNER_BUILD_METADATA);
}
export function verifyReleaseRunnerMetadata(metadata, expected) {
  if (metadata.binaryContractVersion !== expected.contracts.runnerdArtifact
    || metadata.nativeExecutionVersion !== expected.contracts.nativeExecution
    || metadata.harnessDriverVersion !== expected.contracts.harnessDriver
    || metadata.packageName !== expected.package.name || metadata.packageVersion !== expected.package.version
    || metadata.prp?.name !== expected.prp.name || metadata.prp.minimumVersion > expected.prp.maximumVersion
    || metadata.prp.maximumVersion < expected.prp.minimumVersion) throw Error("Release daemon build metadata is incompatible with the production contract");
  return metadata;
}

export function releaseDaemonManifest(artifactDirectory, sourceRevision, verifyMetadata) {
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw Error("Release daemons require an immutable source revision");
  if (readdirSync(artifactDirectory).sort().join() !== [...required].sort().join()) throw Error("Release daemons require exactly the four supported target directories");
  const platforms = {};
  for (const target of required) {
    const directory = join(resolve(artifactDirectory), target);
    if (readdirSync(directory).sort().join() !== "paperclip-runnerd,receipt.json") throw Error("Release target must contain only its daemon and receipt");
    const receipt = JSON.parse(regularFile(join(directory, "receipt.json"), 64 * 1024));
    const path = join(directory, "paperclip-runnerd"), bytes = regularFile(path, 256 * 1024 * 1024);
    if (receipt.schema !== "paperclip.runner.release-artifact.v1" || receipt.sourceRevision !== sourceRevision
      || receipt.target !== target || receipt.sha256 !== digest(bytes) || runnerBinaryTarget(bytes) !== target) {
      throw Error(`Release daemon ${target} source, digest or architecture mismatch`);
    }
    verifyMetadata(receipt.buildMetadata);
    platforms[target] = { path, sha256: receipt.sha256, buildMetadata: receipt.buildMetadata };
  }
  return { sourceRevision, platforms };
}

export function existingReleaseProviderPack(packageRoot, sourceRevision, target = "linux-x64") {
  if (!RELEASE_PROVIDER_PACK_TARGETS.includes(target)) throw Error("Unsupported release provider pack target");
  const file = join(packageRoot, `dist/remote-provider-packs/${target}/provider-pack.json`);
  if (!existsSync(file)) return undefined;
  return verifyReleaseProviderPack(JSON.parse(regularFile(file, 512 * 1024)), sourceRevision, target);
}

export function releaseProviderPackManifest(artifactDirectory, sourceRevision) {
  if (readdirSync(artifactDirectory).sort().join() !== [...RELEASE_PROVIDER_PACK_TARGETS].sort().join()) {
    throw Error("Release provider packs require exactly both Linux target directories");
  }
  return Object.fromEntries(RELEASE_PROVIDER_PACK_TARGETS.map(target => {
    const path = join(resolve(artifactDirectory), target, "provider-pack.json");
    const bytes = regularFile(path, 512 * 1024);
    verifyReleaseProviderPack(JSON.parse(bytes), sourceRevision, target);
    return [target, { path, sha256: digest(bytes) }];
  }));
}

async function main() {
  if (process.argv[2] === "record") {
    const [, , , sourceRevision, target, source, output] = process.argv;
    if (process.argv.length !== 7 || !/^[a-f0-9]{40}$/.test(sourceRevision) || !required.includes(target)
      || target !== `${process.platform}-${process.arch}`) throw Error("Record requires the exact source and actual producer host target");
    const bytes = regularFile(resolve(source), 256 * 1024 * 1024);
    if (runnerBinaryTarget(bytes) !== target) throw Error("Built daemon architecture does not match its producer");
    const buildMetadata = JSON.parse(execFileSync(resolve(source), ["--build-metadata"], {
      timeout: 15_000, maxBuffer: 64 * 1024, encoding: "utf8",
    }));
    (await metadataContract())(buildMetadata);
    mkdirSync(output, { recursive: true });
    copyFileSync(source, join(output, "paperclip-runnerd"));
    writeFileSync(join(output, "receipt.json"), JSON.stringify({ schema: "paperclip.runner.release-artifact.v1",
      sourceRevision, target, sha256: digest(bytes), buildMetadata }, null, 2) + "\n");
    return;
  }
  const daemonOnly = process.argv[2] === "assemble-daemons";
  if (daemonOnly ? ![5, 6].includes(process.argv.length) : process.argv.length !== 3) throw Error("Usage: stage-release-runner-binaries.mjs MANIFEST.json | assemble-daemons ARTIFACT_DIRECTORY SOURCE_SHA");
  const manifest = daemonOnly
    ? releaseDaemonManifest(process.argv[3], process.argv[4], await metadataContract())
    : JSON.parse(regularFile(resolve(process.argv[2]), 512 * 1024));
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceRevision) || !manifest.platforms || Object.keys(manifest.platforms).sort().join() !== [...required].sort().join()) throw Error("Release daemon manifest must bind one source and all four supported targets");
  if (daemonOnly && process.argv[5]) manifest.remoteProviderPacks = releaseProviderPackManifest(process.argv[5], manifest.sourceRevision);
  const verified = required.map(target => {
    const artifact = manifest.platforms[target];
    if (!artifact || !isAbsolute(artifact.path) || !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256)) throw Error(`Invalid ${target} release artifact`);
    const bytes = regularFile(artifact.path, 256 * 1024 * 1024), sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== artifact.sha256 || runnerBinaryTarget(bytes) !== target) throw Error(`Release daemon ${target} digest or architecture mismatch`);
    return { target, source: artifact.path, sha256 };
  });
  if (!manifest.remoteProviderPack && !manifest.remoteProviderPacks && !daemonOnly) throw Error("Release assembly requires the matching Linux remote provider pack");
  if (manifest.remoteProviderPacks && Object.keys(manifest.remoteProviderPacks).sort().join() !== [...RELEASE_PROVIDER_PACK_TARGETS].sort().join()) {
    throw Error("Release provider packs require exactly both Linux targets");
  }
  const packs = {};
  for (const target of RELEASE_PROVIDER_PACK_TARGETS) {
    const entry = manifest.remoteProviderPacks?.[target] ?? (target === "linux-x64" ? manifest.remoteProviderPack : undefined);
    if (entry) {
      if (!isAbsolute(entry.path) || !/^sha256:[a-f0-9]{64}$/.test(entry.sha256)) throw Error("Invalid remote provider-pack release artifact");
      const bytes = regularFile(entry.path, 512 * 1024);
      if (digest(bytes) !== entry.sha256) throw Error("Remote provider-pack release manifest digest mismatch");
      packs[target] = { bytes, identity: verifyReleaseProviderPack(JSON.parse(bytes), manifest.sourceRevision, target) };
      if (target === "linux-x64" && manifest.remoteProviderPack && manifest.remoteProviderPacks &&
        (manifest.remoteProviderPack.path !== entry.path || manifest.remoteProviderPack.sha256 !== entry.sha256)) {
        throw Error("Conflicting legacy Linux x64 provider-pack identity");
      }
    } else if (daemonOnly) {
      const identity = existingReleaseProviderPack(root, manifest.sourceRevision, target);
      if (identity) packs[target] = { identity };
    }
  }
  const platforms = {};
  for (const artifact of verified) {
    const relative = `${artifact.target}/paperclip-runnerd`, destination = join(root, "dist", "bin", relative);
    mkdirSync(dirname(destination), { recursive: true }); copyFileSync(artifact.source, destination); chmodSync(destination, 0o755);
    if (process.platform === "darwin" && artifact.target.startsWith("darwin-")) {
      execFileSync("codesign", ["--force", "--sign", "-", destination], { stdio: "pipe", timeout: 30_000 });
    }
    const sha256 = "sha256:" + createHash("sha256").update(readFileSync(destination)).digest("hex");
    platforms[artifact.target] = { path: relative, sha256, sourceSha256: artifact.sha256 };
  }
  for (const [target, pack] of Object.entries(packs)) {
    if (!pack.bytes) continue;
    const destination = join(root, "dist", "remote-provider-packs", target, "provider-pack.json");
    mkdirSync(dirname(destination), { recursive: true });
    const staged = `${destination}.staging-${process.pid}`;
    try {
      writeFileSync(staged, pack.bytes, { mode: 0o444, flag: "wx" });
      renameSync(staged, destination);
    } finally {
      rmSync(staged, { force: true });
    }
  }
  writeFileSync(join(root, "dist", "bin", "release-manifest.json"), JSON.stringify({schema:"paperclip.runner.release-binaries.v1",sourceRevision:manifest.sourceRevision,platforms,
    ...(packs["linux-x64"] ? { remoteProviderPack: { target: "linux-x64", digest: packs["linux-x64"].identity.digest, sourceRevision: packs["linux-x64"].identity.payload.runnerSourceRevision } } : {}),
    ...(Object.keys(packs).length ? { remoteProviderPacks: Object.fromEntries(Object.entries(packs).map(([target, pack]) => [target, { target, digest: pack.identity.digest, sourceRevision: pack.identity.payload.runnerSourceRevision }])) } : {})},null,2)+"\n");
  console.log("Staged verified release daemons for " + required.join(", "));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

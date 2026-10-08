#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeDataPath = "packages/paperclip-runner/src/drivers/acpx/qualified-runtime-artifacts.json";
const nativeTargets = ["linux-x64", "darwin-arm64", "darwin-x64"];
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function materializePublishManifest(pkg) {
  const publishConfig = pkg.publishConfig ?? {};
  const publishManifest = { ...pkg };

  for (const key of ["main", "types", "exports", "bin"]) {
    if (publishConfig[key] !== undefined) publishManifest[key] = publishConfig[key];
  }

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!publishManifest[section]) continue;
    publishManifest[section] = Object.fromEntries(
      Object.entries(publishManifest[section]).map(([name, specifier]) => {
        if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) return [name, specifier];
        const range = specifier.slice("workspace:".length);
        const prefix = range === "^" || range === "~" ? range : "";
        return [name, `${prefix}${pkg.version}`];
      }),
    );
  }

  delete publishManifest.publishConfig;
  return publishManifest;
}

export function createBundledInstallManifest(publishManifest, bundledDependencies) {
  const bundledDependencyNames = new Set(bundledDependencies);
  const installManifest = structuredClone(publishManifest);

  delete installManifest.devDependencies;

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!installManifest[section]) continue;
    installManifest[section] = Object.fromEntries(
      Object.entries(installManifest[section]).filter(([name]) => bundledDependencyNames.has(name)),
    );
    if (Object.keys(installManifest[section]).length === 0) delete installManifest[section];
  }

  return installManifest;
}

// npm consumers cannot inherit the workspace's pnpm overrides or patches.
// Materialize these two already-qualified bridge closures in the tarball,
// with overrides confined to the temporary, scripts-disabled producer graph.
export function configureBundledProviderOverrides(installManifest, bundledDependencies, rootPackage, profileData,
  runtimeData = JSON.parse(readFileSync(resolve(repoRoot, runtimeDataPath), "utf8"))) {
  const result = structuredClone(installManifest);
  const selected = [];
  for (const [agent, serverPackage, runtimePackage] of [
    ["codex", "@agentclientprotocol/codex-acp", "@openai/codex"],
    ["claude", "@agentclientprotocol/claude-agent-acp", "@anthropic-ai/claude-agent-sdk"],
  ]) {
    if (!bundledDependencies.includes(serverPackage)) continue;
    const profile = profileData?.profiles?.[agent];
    if (profileData?.schema !== "paperclip.acpx-profiles.v1" || profile?.agentServerPackage !== serverPackage
      || profile.agentRuntimePackage !== runtimePackage || !/^\d+\.\d+\.\d+$/.test(profile.agentServerVersion ?? "")
      || !/^\d+\.\d+\.\d+$/.test(profile.agentRuntimeVersion ?? "")
      || result.dependencies?.[serverPackage] !== profile.agentServerVersion) {
      throw new Error(`Bundled ${agent} bridge must match its exact qualified profile`);
    }
    const selector = `${serverPackage}@${profile.agentServerVersion}>${runtimePackage}`;
    if (rootPackage.pnpm?.overrides?.[selector] !== profile.agentRuntimeVersion) {
      throw new Error(`Bundled ${agent} runtime override must match its qualified profile`);
    }
    const npmSelector = `${serverPackage}@${profile.agentServerVersion}`;
    if (result.overrides?.[npmSelector] !== undefined) {
      throw new Error(`Bundled ${agent} runtime has a conflicting producer override`);
    }
    const overrides = { [runtimePackage]: profile.agentRuntimeVersion };
    if (agent === "claude") {
      const dependencies = runtimeData?.claude?.dependencies;
      if (runtimeData?.schema !== "paperclip.acpx-runtime-artifacts.v1" || !Array.isArray(dependencies)
        || dependencies.length !== 3 || new Set(dependencies.map(value => value.packageName)).size !== 3
        || dependencies.some(value => !["@agentclientprotocol/sdk", runtimePackage, "zod"].includes(value.packageName)
          || !/^\d+\.\d+\.\d+$/.test(value.packageVersion ?? ""))) {
        throw new Error("Bundled Claude supplemental dependency contract is malformed");
      }
      for (const dependency of dependencies) overrides[dependency.packageName] = dependency.packageVersion;
      if (overrides[runtimePackage] !== profile.agentRuntimeVersion) throw new Error("Bundled Claude supplemental SDK conflicts with its qualified profile");
    }
    result.overrides = { ...result.overrides, [npmSelector]: overrides };
    selected.push({ agent, ...profile });
  }
  return { installManifest: result, profiles: selected };
}

const inside = (root, candidate) => {
  const value = relative(root, candidate);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};

function resolveBundledDependencyManifest(issuerRequire, packageName, graphRoot) {
  let manifestPath;
  try { manifestPath = issuerRequire.resolve(`${packageName}/package.json`); }
  catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    const parts = packageName.split("/");
    if (parts.length < 1 || parts.length > 2 || parts.some(part => !part || part === "..")) throw new Error("Invalid bundled dependency package name");
    let directory = dirname(realpathSync(issuerRequire.resolve(packageName)));
    // Match the production resolver's bounded manifest lookup for packages
    // that export only a nested entrypoint, rather than package.json itself.
    for (let count = 0; count < 64 && inside(graphRoot, directory); count++) {
      if (basename(directory) === parts.at(-1) && (parts.length === 1 || basename(dirname(directory)) === parts[0])) {
        manifestPath = resolve(directory, "package.json");
        break;
      }
      directory = dirname(directory);
    }
    if (!manifestPath) throw new Error(`Bundled dependency manifest could not be located: ${packageName}`);
  }
  const canonical = realpathSync(manifestPath);
  if (!inside(graphRoot, canonical)) throw new Error(`Bundled dependency escapes its producer graph: ${packageName}`);
  return canonical;
}

export function inspectBundledNativeArtifact(directory, profile, target, runtimeData) {
  if (!nativeTargets.includes(target) || runtimeData?.schema !== "paperclip.acpx-runtime-artifacts.v1") throw new Error("Bundled native artifact has no supported target contract");
  const rootStat = lstatSync(directory), manifestStat = lstatSync(resolve(directory, "package.json"));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.nlink !== 1 || manifestStat.size > 256 * 1024) {
    throw new Error("Bundled native artifact manifest is not a bounded regular file");
  }
  const [platform, architecture] = target.split("-");
  const metadata = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  const name = `${profile.agentRuntimePackage}-${target}`;
  const version = profile.agent === "codex" ? `${profile.agentRuntimeVersion}-${target}` : profile.agentRuntimeVersion;
  if (![name, profile.agentRuntimePackage].includes(metadata.name) || metadata.version !== version
    || !Array.isArray(metadata.os) || !metadata.os.includes(platform) || !Array.isArray(metadata.cpu) || !metadata.cpu.includes(architecture)
    || Object.keys(metadata.dependencies ?? {}).length || Object.keys(metadata.optionalDependencies ?? {}).length || Object.keys(metadata.scripts ?? {}).length) {
    throw new Error(`Bundled ${profile.agent} native artifact identity mismatch: ${target}`);
  }
  const qualification = runtimeData?.[profile.agent]?.platforms?.[target];
  if (!qualification && !(profile.agent === "codex" && platform === "darwin")) throw new Error("Bundled native artifact omitted its existing executable qualification");
  const relativeExecutable = qualification?.relativeExecutable ?? (profile.agent === "codex" && platform === "darwin"
    ? `vendor/${architecture === "arm64" ? "aarch64" : "x86_64"}-apple-darwin/bin/codex` : undefined);
  if (!relativeExecutable || relativeExecutable.split("/").some(value => !value || value === "..") || isAbsolute(relativeExecutable)) {
    throw new Error("Bundled native artifact has no recognized executable");
  }
  const entries = [];
  let bytes = 0;
  const walk = (root, prefix = "") => {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("Bundled native artifact contains a linked directory");
    for (const entry of readdirSync(root).sort()) {
      const path = prefix ? `${prefix}/${entry}` : entry;
      if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new Error("Bundled native artifact contains an unsafe path");
      const file = resolve(root, entry), stat = lstatSync(file);
      if (stat.isDirectory()) walk(file, path);
      else {
        if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o7000) throw new Error("Bundled native artifact contains links or special files");
        bytes += stat.size;
        if (bytes > 1024 * 1024 * 1024 || entries.length >= 4096) throw new Error("Bundled native artifact exceeds size limits");
        entries.push({ path, size: stat.size, sha256: digest(readFileSync(file)), executable: Boolean(stat.mode & 0o111) });
      }
    }
  };
  walk(directory);
  const executable = entries.find(entry => entry.path === relativeExecutable);
  if (!executable?.executable) throw new Error("Bundled native artifact has no executable payload");
  const header = readFileSync(resolve(directory, relativeExecutable));
  const correctArchitecture = platform === "linux"
    ? header.length >= 20 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === 62
    : header.length >= 8 && header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === (architecture === "arm64" ? 0x0100000c : 0x01000007);
  if (!correctArchitecture) throw new Error(`Bundled native artifact architecture mismatch: ${target}`);
  if (qualification && (qualification.packageName !== name || qualification.packageVersion !== version
    || qualification.runtimePackageName !== profile.agentRuntimePackage || qualification.runtimePackageVersion !== profile.agentRuntimeVersion
    || qualification.executableDigest !== executable.sha256)) throw new Error(`Bundled native artifact qualified digest mismatch: ${name}`);
  return { agent: profile.agent, target, packageName: name, packageVersion: version, size: bytes,
    executable: relativeExecutable, executableDigest: executable.sha256, qualification: qualification ? "existing executable hash" : "native Codex package/version; ACPX qualification unchanged",
    closureDigest: digest(JSON.stringify(entries)), entries };
}

export function stageBundledProviderOptionalDependencies(destinationDir, publishManifest, profiles,
  runtimeData = JSON.parse(readFileSync(resolve(repoRoot, runtimeDataPath), "utf8")), { nativeArtifactsDirectory, targets = nativeTargets } = {}) {
  if (!Array.isArray(targets) || targets.length === 0 || new Set(targets).size !== targets.length
    || targets.some(target => !nativeTargets.includes(target))) throw new Error("Invalid bundled native target selection");
  const result = structuredClone(publishManifest);
  const graphRoot = realpathSync(resolve(destinationDir, "node_modules"));
  const artifacts = [], nativeDependencies = {};
  for (const profile of profiles) {
    const bridgeManifestPath = resolve(graphRoot, profile.agentServerPackage, "package.json");
    const bridge = JSON.parse(readFileSync(bridgeManifestPath, "utf8"));
    if (bridge.name !== profile.agentServerPackage || bridge.version !== profile.agentServerVersion) {
      throw new Error(`Bundled ${profile.agent} bridge version mismatch`);
    }
    const bridgeRequire = createRequire(bridgeManifestPath);
    const runtimeManifestPath = resolveBundledDependencyManifest(bridgeRequire, profile.agentRuntimePackage, graphRoot);
    const runtime = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
    if (runtime.name !== profile.agentRuntimePackage || runtime.version !== profile.agentRuntimeVersion) {
      throw new Error(`Bundled ${profile.agent} runtime version mismatch`);
    }
    const optional = Object.entries(runtime.optionalDependencies ?? {});
    if (optional.length === 0) throw new Error(`Bundled ${profile.agent} runtime omitted platform artifacts`);
    const runtimeRequire = createRequire(runtimeManifestPath);
    for (const [name, specifier] of optional) {
      const suffix = name.slice(profile.agentRuntimePackage.length + 1);
      const recognized = name.startsWith(`${profile.agentRuntimePackage}-`) && (profile.agent === "codex"
        ? /^(linux|darwin|win32)-(x64|arm64)$/.test(suffix)
        : /^(linux-(x64|arm64)(-musl)?|darwin-(x64|arm64)|win32-(x64|arm64))$/.test(suffix));
      const version = profile.agent === "codex" ? `${runtime.version}-${suffix}` : runtime.version;
      const expected = profile.agent === "codex" ? `npm:${runtime.name}@${version}` : version;
      if (!recognized || specifier !== expected) throw new Error(`Bundled ${profile.agent} platform artifact is not qualified: ${name}`);
      if (result.optionalDependencies?.[name] !== undefined && result.optionalDependencies[name] !== expected) {
        throw new Error(`Bundled ${profile.agent} platform artifact conflicts with published dependency: ${name}`);
      }
      if (targets.includes(suffix)) {
        result.optionalDependencies = { ...result.optionalDependencies, [name]: expected };
        nativeDependencies[name] = expected;
      }
      // Remove only recognized producer-platform payloads before staging the
      // bounded supported target set. Preserve the original runtime manifest.
      for (const lookup of runtimeRequire.resolve.paths(name) ?? []) {
        const candidate = resolve(lookup, name);
        if (!inside(graphRoot, candidate) || !existsSync(candidate)) continue;
        if (lstatSync(candidate).isSymbolicLink() || !inside(graphRoot, realpathSync(candidate))) {
          throw new Error(`Bundled ${profile.agent} platform artifact escapes its producer graph`);
        }
        const artifact = JSON.parse(readFileSync(resolve(candidate, "package.json"), "utf8"));
        if (![name, runtime.name].includes(artifact.name) || artifact.version !== version) {
          throw new Error(`Bundled ${profile.agent} installed platform artifact version mismatch: ${name}`);
        }
        rmSync(candidate, { recursive: true, force: true });
      }
    }
    if (profile.agent === "claude") for (const expected of runtimeData.claude.dependencies) {
      if (bridge.dependencies?.[expected.packageName] !== expected.dependencyDeclaration) throw new Error("Bundled Claude bridge dependency declaration mismatch");
      const manifestPath = resolveBundledDependencyManifest(bridgeRequire, expected.packageName, graphRoot);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!inside(graphRoot, realpathSync(manifestPath)) || manifest.name !== expected.packageName || manifest.version !== expected.packageVersion) {
        throw new Error(`Bundled Claude supplemental dependency version mismatch: ${expected.packageName}`);
      }
    }
  }
  if (Object.keys(nativeDependencies).length !== profiles.length * targets.length) throw new Error("Bundled provider omitted a supported native target");
  const temporary = mkdtempSync(resolve(destinationDir, ".paperclip-native-artifacts-"));
  try {
    writeFileSync(resolve(temporary, "package.json"), JSON.stringify({ private: true, name: "paperclip-native-artifact-staging", version: "1.0.0", dependencies: nativeDependencies }));
    if (!nativeArtifactsDirectory) execFileSync("npm", ["install", "--force", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: temporary, stdio: "inherit", timeout: 180_000 });
    for (const profile of profiles) for (const target of targets) {
      const name = `${profile.agentRuntimePackage}-${target}`;
      const input = resolve(nativeArtifactsDirectory ?? resolve(temporary, "node_modules"), name);
      const artifact = inspectBundledNativeArtifact(input, profile, target, runtimeData);
      const output = resolve(graphRoot, name);
      if (existsSync(output)) throw new Error("Bundled native artifact destination already exists");
      cpSync(input, output, { recursive: true, dereference: false });
      for (const entry of artifact.entries) chmodSync(resolve(output, entry.path), entry.executable ? 0o755 : 0o644);
      const copied = inspectBundledNativeArtifact(output, profile, target, runtimeData);
      if (copied.closureDigest !== artifact.closureDigest) throw new Error("Bundled native artifact changed during staging");
      artifacts.push(copied);
      result.bundleDependencies = [...new Set([...(result.bundleDependencies ?? result.bundledDependencies ?? []), name])];
    }
    const total = artifacts.reduce((size, artifact) => size + artifact.size, 0);
    if (total > 2 * 1024 * 1024 * 1024) throw new Error("Bundled native provider payload exceeds release size limit");
    result.paperclipProviderArtifacts = { schema: "paperclip.bundled-provider-artifacts.v1", providerCalls: 0, lifecycleScriptsRun: false,
      totalBytes: total, artifacts: artifacts.map(({ entries, ...artifact }) => artifact) };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return result;
}

export function dockerBundledProviderTarget(architecture,
  runtimeData = JSON.parse(readFileSync(resolve(repoRoot, runtimeDataPath), "utf8"))) {
  const architectures = { amd64: "x64", arm64: "arm64" };
  if (!Object.hasOwn(architectures, architecture) || runtimeData?.schema !== "paperclip.acpx-runtime-artifacts.v1") {
    throw new Error("Docker provider materialization requires a declared supported target architecture and qualification contract");
  }
  const target = `linux-${architectures[architecture]}`;
  // A Docker target selects an already-qualified artifact; it cannot qualify
  // a new platform. Unqualified native targets retain their normal legacy CLI.
  return ["codex", "claude"].every(agent => runtimeData[agent]?.platforms?.[target]) ? target : null;
}

export function mergeBundledProviderGraph(stagedDirectory, serverDirectory) {
  for (const directory of [stagedDirectory, serverDirectory]) {
    if (!isAbsolute(directory) || resolve(directory) !== directory || directory === "/" || realpathSync(directory) !== directory) {
      throw new Error("Docker provider graph requires canonical owned package directories");
    }
  }
  const input = resolve(stagedDirectory, "node_modules"), output = resolve(serverDirectory, "node_modules");
  if (!existsSync(output)) mkdirSync(output);
  if (realpathSync(input) !== input || realpathSync(output) !== output) throw new Error("Docker provider node_modules cannot escape its package");
  const names = ["@agentclientprotocol/codex-acp", "@agentclientprotocol/claude-agent-acp"];
  const serverMetadata = JSON.parse(readFileSync(resolve(serverDirectory, "package.json"), "utf8"));
  for (const name of names) {
    const source = resolve(input, name), stat = lstatSync(source);
    const metadata = JSON.parse(readFileSync(resolve(source, "package.json"), "utf8"));
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(source) !== source
      || metadata.name !== name || metadata.version !== serverMetadata.dependencies?.[name]) {
      throw new Error("Docker provider bridge identity mismatch");
    }
  }
  // Keep the provider closure nested and physically inside the server's own
  // authority. Changing unrelated direct server bindings (for example zod)
  // would change application behavior even when no native agent is running.
  const owned = resolve(output, ".paperclip-native-providers");
  if (lstatExists(owned)) throw new Error("Docker provider graph destination already exists");
  cpSync(stagedDirectory, owned, { recursive: true, dereference: false, verbatimSymlinks: true });
  chmodSync(owned, 0o755);
  for (const name of names) {
    const destination = resolve(output, name), namespace = dirname(destination);
    if (!existsSync(namespace)) mkdirSync(namespace);
    if (realpathSync(namespace) !== namespace) throw new Error("Docker provider namespace cannot resolve outside the server");
    if (lstatExists(destination)) {
      const stat = lstatSync(destination);
      // pnpm's store is untouched; remove only its server-local package link.
      if (!stat.isSymbolicLink()) throw new Error("Docker provider entry binding must be a workspace package link");
      rmSync(destination);
    }
    symlinkSync(relative(namespace, resolve(owned, "node_modules", name)), destination, "dir");
    if (!inside(output, realpathSync(destination))) throw new Error("Docker provider bridge escaped its server authority");
  }
}

function lstatExists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

// A Linux-produced bundle contains esbuild's JavaScript but only the producer's
// optional executable. Expose its exact platform declarations to the consumer,
// just as embedded-postgres does below, before retaining the original hooks.
export function stageBundledEsbuildOptionalDependencies(destinationDir, publishManifest) {
  const graphRoot = resolve(destinationDir, "node_modules");
  if (realpathSync(graphRoot) !== graphRoot) throw new Error("Bundled esbuild graph must be a canonical owned directory");
  const result = structuredClone(publishManifest), pending = [{ directory: graphRoot, depth: 0 }];
  const optional = {}, remove = new Set();
  let packageCount = 0;
  const ownedDirectory = directory => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(graphRoot, realpathSync(directory))) {
      throw new Error("Bundled esbuild dependency escapes its producer graph");
    }
  };
  const manifestAt = directory => {
    const file = resolve(directory, "package.json"), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) {
      throw new Error("Bundled esbuild dependency manifest must be a bounded regular file");
    }
    return JSON.parse(readFileSync(file, "utf8"));
  };
  while (pending.length) {
    const { directory, depth } = pending.pop();
    if (depth > 64) throw new Error("Bundled esbuild dependency graph exceeds its depth limit");
    const packages = [];
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith(".")) continue;
      const candidate = resolve(directory, entry);
      ownedDirectory(candidate);
      if (entry.startsWith("@")) {
        for (const child of readdirSync(candidate)) {
          const scoped = resolve(candidate, child); ownedDirectory(scoped); packages.push(scoped);
        }
      } else packages.push(candidate);
    }
    for (const packageDirectory of packages) {
      if (++packageCount > 20_000) throw new Error("Bundled esbuild dependency graph exceeds its package limit");
      const metadata = manifestAt(packageDirectory);
      const nested = resolve(packageDirectory, "node_modules");
      if (lstatExists(nested)) { ownedDirectory(nested); pending.push({ directory: nested, depth: depth + 1 }); }
      if (basename(packageDirectory) !== "esbuild") continue;
      if (metadata.name !== "esbuild" || !/^\d+\.\d+\.\d+$/.test(metadata.version ?? "")) {
        throw new Error("Bundled esbuild package identity mismatch");
      }
      const declarations = metadata.optionalDependencies ?? {};
      if (nativeTargets.some(target => declarations[`@esbuild/${target}`] !== metadata.version)) {
        throw new Error("Bundled esbuild omitted a supported platform declaration");
      }
      const issuer = createRequire(resolve(packageDirectory, "package.json"));
      for (const [name, version] of Object.entries(declarations)) {
        if (!/^@esbuild\/[a-z0-9]+-[a-z0-9]+$/.test(name) || version !== metadata.version) {
          throw new Error("Bundled esbuild platform declaration must match its exact package version");
        }
        if ((optional[name] !== undefined && optional[name] !== version)
          || (result.optionalDependencies?.[name] !== undefined && result.optionalDependencies[name] !== version)) {
          throw new Error(`Bundled esbuild platform version conflicts with published dependency: ${name}`);
        }
        optional[name] = version;
        for (const lookup of issuer.resolve.paths(name) ?? []) {
          const candidate = resolve(lookup, name);
          if (!inside(graphRoot, candidate) || !lstatExists(candidate)) continue;
          ownedDirectory(candidate);
          const installed = manifestAt(candidate);
          if (installed.name !== name || installed.version !== version) {
            throw new Error(`Bundled esbuild installed platform identity mismatch: ${name}`);
          }
          remove.add(candidate);
        }
      }
    }
  }
  for (const directory of remove) rmSync(directory, { recursive: true, force: true });
  if (Object.keys(optional).length) result.optionalDependencies = { ...result.optionalDependencies, ...optional };
  return result;
}

// Keep OpenCode's pinned wrapper in the server graph, but let each consumer
// install its own declared platform dependency rather than the producer binary.
export function stageBundledOpenCodeOptionalDependencies(destinationDir, publishManifest) {
  const bundled = publishManifest.bundleDependencies ?? publishManifest.bundledDependencies ?? [];
  if (!bundled.includes("opencode-ai")) return structuredClone(publishManifest);
  const expected = JSON.parse(readFileSync(resolve(repoRoot, "packages/paperclip-runner/package.json"), "utf8")).dependencies["opencode-ai"];
  const graph = resolve(destinationDir, "node_modules");
  const wrapper = resolve(graph, "opencode-ai");
  if (!/^\d+\.\d+\.\d+$/.test(expected) || publishManifest.dependencies?.["opencode-ai"] !== expected
    || realpathSync(graph) !== graph || realpathSync(wrapper) !== wrapper || !lstatSync(wrapper).isDirectory()) {
    throw new Error("Bundled OpenCode must use its declared qualified dependency in the owned producer graph");
  }
  const metadata = JSON.parse(readFileSync(resolve(wrapper, "package.json"), "utf8"));
  if (metadata.name !== "opencode-ai" || metadata.version !== expected || metadata.bin?.opencode !== "./bin/opencode.exe") {
    throw new Error("Bundled OpenCode wrapper identity mismatch");
  }
  const optional = metadata.optionalDependencies;
  if (!optional || typeof optional !== "object" || Array.isArray(optional)
    || Object.keys(optional).length > 20
    || ["opencode-linux-x64-baseline", "opencode-darwin-arm64", "opencode-darwin-x64-baseline"].some(name => optional[name] !== expected)) {
    throw new Error("Bundled OpenCode omitted a supported platform dependency");
  }
  const remove = new Set();
  for (const [name, version] of Object.entries(optional)) {
    if (!/^opencode-(?:darwin|linux|windows)-(?:arm64|x64)(?:-baseline)?(?:-musl)?$/.test(name) || version !== expected
      || (publishManifest.optionalDependencies?.[name] !== undefined && publishManifest.optionalDependencies[name] !== expected)) {
      throw new Error("Bundled OpenCode platform dependency version mismatch");
    }
    for (const candidate of [resolve(graph, name), resolve(wrapper, "node_modules", name)]) {
      if (!lstatExists(candidate)) continue;
      if (!lstatSync(candidate).isDirectory() || realpathSync(candidate) !== candidate || !inside(graph, candidate)) {
        throw new Error("Bundled OpenCode platform artifact escapes its producer graph");
      }
      const artifact = JSON.parse(readFileSync(resolve(candidate, "package.json"), "utf8"));
      if (artifact.name !== name || artifact.version !== expected) {
        throw new Error("Bundled OpenCode installed platform identity mismatch");
      }
      remove.add(candidate);
    }
  }
  const materialized = resolve(wrapper, "bin/opencode.exe");
  if (lstatExists(materialized) && (!lstatSync(materialized).isFile() || realpathSync(materialized) !== materialized)) {
    throw new Error("Bundled OpenCode materialized executable must be a regular owned file");
  }
  for (const candidate of remove) rmSync(candidate, { recursive: true, force: true });
  if (lstatExists(materialized)) rmSync(materialized);
  return {
    ...structuredClone(publishManifest),
    optionalDependencies: { ...publishManifest.optionalDependencies, ...optional },
  };
}

export function materializeDockerProviderGraph(serverDirectory, architecture, { sourceRoot = repoRoot } = {}) {
  const runtimeData = JSON.parse(readFileSync(resolve(sourceRoot, runtimeDataPath), "utf8"));
  const target = dockerBundledProviderTarget(architecture, runtimeData);
  if (!target) return { target: `linux-${architecture === "arm64" ? "arm64" : "x64"}`, materialized: false, reason: "Native providers are not qualified for this target; legacy installation preserved" };
  const metadata = JSON.parse(readFileSync(resolve(serverDirectory, "package.json"), "utf8"));
  const names = ["@agentclientprotocol/codex-acp", "@agentclientprotocol/claude-agent-acp"];
  const temporary = realpathSync(mkdtempSync(resolve(tmpdir(), "paperclip-docker-provider-graph-")));
  try {
    const source = resolve(temporary, "source"), staged = resolve(temporary, "staged"); mkdirSync(source);
    writeFileSync(resolve(source, "package.json"), JSON.stringify({ name: metadata.name, version: metadata.version, type: "module", files: [],
      dependencies: Object.fromEntries(names.map(name => [name, metadata.dependencies?.[name]])), bundleDependencies: names }));
    prepareBundledPackage(source, staged, { sourceRoot, targets: [target] });
    mergeBundledProviderGraph(staged, serverDirectory);
    const stagedMetadata = JSON.parse(readFileSync(resolve(staged, "package.json"), "utf8"));
    return { target, materialized: true, artifacts: stagedMetadata.paperclipProviderArtifacts, providerCalls: 0, lifecycleScriptsRun: false };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function patchedDependencyPackageName(specifier) {
  const versionSeparator = specifier.lastIndexOf("@");
  const packageNameEnd = specifier.startsWith("@") ? specifier.indexOf("/") : 0;
  if (packageNameEnd < 0) return specifier;
  return versionSeparator > packageNameEnd ? specifier.slice(0, versionSeparator) : specifier;
}

export function selectBundledDependencyPatches(
  destinationDir,
  bundledDependencies,
  patchedDependencies,
) {
  const patchesByPackageName = new Map();
  for (const [specifier, patchPath] of Object.entries(patchedDependencies)) {
    const packageName = patchedDependencyPackageName(specifier);
    const packagePatches = patchesByPackageName.get(packageName) ?? new Map();
    packagePatches.set(specifier, patchPath);
    patchesByPackageName.set(packageName, packagePatches);
  }

  const selectedPatches = [];
  for (const packageName of new Set(bundledDependencies)) {
    const packagePatches = patchesByPackageName.get(packageName);
    if (!packagePatches) continue;

    const installedManifestPath = resolve(
      destinationDir,
      "node_modules",
      packageName,
      "package.json",
    );
    let installedManifest;
    try {
      installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8"));
    } catch (cause) {
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: failed to read ${installedManifestPath}`,
        { cause },
      );
    }

    if (
      installedManifest.name !== packageName ||
      typeof installedManifest.version !== "string" ||
      installedManifest.version.length === 0
    ) {
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: installed package manifest must declare the expected name and a version`,
      );
    }

    const installedSpecifier = `${packageName}@${installedManifest.version}`;
    const patchPath = packagePatches.get(installedSpecifier);
    if (patchPath === undefined) {
      const configuredSpecifiers = [...packagePatches.keys()].sort().join(", ");
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: installed ${installedSpecifier}, but configured patches are ${configuredSpecifiers}`,
      );
    }
    if (typeof patchPath !== "string" || patchPath.length === 0) {
      throw new Error(`Patch path for ${installedSpecifier} must be a non-empty string`);
    }
    selectedPatches.push({ packageName, specifier: installedSpecifier, patchPath });
  }

  return selectedPatches;
}

export function applyBundledDependencyPatches(destinationDir, bundledDependencies, sourceRoot = repoRoot) {
  const rootPackage = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8"));
  const patchedDependencies = rootPackage.pnpm?.patchedDependencies ?? {};

  for (const { packageName, patchPath } of selectBundledDependencyPatches(
    destinationDir,
    bundledDependencies,
    patchedDependencies,
  )) {
    execFileSync(
      "patch",
      ["-p1", "--forward", "-d", resolve(destinationDir, "node_modules", packageName)],
      {
        input: readFileSync(resolve(sourceRoot, patchPath)),
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
  }
}

export function prepareBundledPackage(sourceDir, destinationDir, { sourceRoot = repoRoot, targets = nativeTargets } = {}) {
  const sourcePackagePath = resolve(sourceDir, "package.json");
  const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, "utf8"));
  const bundledDependencies = sourcePackage.bundleDependencies ?? sourcePackage.bundledDependencies ?? [];

  if (bundledDependencies.length === 0) {
    throw new Error(`${sourcePackage.name} does not declare bundled dependencies`);
  }

  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of sourcePackage.files ?? []) {
    cpSync(resolve(sourceDir, entry), resolve(destinationDir, entry), { recursive: true });
  }
  for (const entry of ["README.md", "LICENSE", "LICENSE.md"]) {
    const sourcePath = resolve(sourceDir, entry);
    if (existsSync(sourcePath)) cpSync(sourcePath, resolve(destinationDir, entry));
  }

  const deployedPackagePath = resolve(destinationDir, "package.json");
  const publishManifest = materializePublishManifest(sourcePackage);
  const rootPackage = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8"));
  const profileData = bundledDependencies.some(name => name === "@agentclientprotocol/codex-acp" || name === "@agentclientprotocol/claude-agent-acp")
    ? JSON.parse(readFileSync(resolve(sourceRoot, "packages/paperclip-runner/acpx-profiles.json"), "utf8")) : undefined;
  const runtimeData = profileData ? JSON.parse(readFileSync(resolve(sourceRoot, runtimeDataPath), "utf8")) : undefined;
  const { installManifest, profiles } = configureBundledProviderOverrides(
    createBundledInstallManifest(publishManifest, bundledDependencies), bundledDependencies, rootPackage, profileData, runtimeData,
  );
  writeFileSync(deployedPackagePath, `${JSON.stringify(installManifest, null, 2)}\n`);

  execFileSync(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: destinationDir, stdio: "inherit" },
  );
  writeFileSync(deployedPackagePath, `${JSON.stringify(publishManifest, null, 2)}\n`);
  applyBundledDependencyPatches(destinationDir, bundledDependencies, sourceRoot);
  if (profiles.length) writeFileSync(deployedPackagePath, `${JSON.stringify(stageBundledProviderOptionalDependencies(destinationDir, publishManifest, profiles, runtimeData, { targets }), null, 2)}\n`);

  if (bundledDependencies.includes("acpx")) {
    const acpxPackage = JSON.parse(
      readFileSync(resolve(destinationDir, "node_modules/acpx/package.json"), "utf8"),
    );
    const expectedPatchMarker = {
      "0.12.0": "onAgentStderr",
      "0.13.1": "spawnEnvironment",
    }[acpxPackage.version];
    const acpxRuntime = readFileSync(
      resolve(destinationDir, "node_modules/acpx/dist/runtime.js"),
      "utf8",
    );
    if (!expectedPatchMarker || !acpxRuntime.includes(expectedPatchMarker)) {
      throw new Error(
        `staged acpx@${acpxPackage.version} runtime is missing the repository patch`,
      );
    }
  }

  if (bundledDependencies.includes("embedded-postgres")) {
    const embeddedPostgresSource = readFileSync(
      resolve(destinationDir, "node_modules/embedded-postgres/dist/index.js"),
      "utf8",
    );
    if (
      !embeddedPostgresSource.includes("const LC_MESSAGES_LOCALE = 'C';") ||
      !embeddedPostgresSource.includes("globalThis.process.env")
    ) {
      throw new Error("staged embedded-postgres runtime is missing the repository patch");
    }

    const embeddedPostgresPackage = JSON.parse(
      readFileSync(resolve(destinationDir, "node_modules/embedded-postgres/package.json"), "utf8"),
    );
    const stagedPackage = JSON.parse(readFileSync(deployedPackagePath, "utf8"));
    stagedPackage.optionalDependencies = {
      ...(stagedPackage.optionalDependencies ?? {}),
      ...(embeddedPostgresPackage.optionalDependencies ?? {}),
    };
    writeFileSync(deployedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`);
    rmSync(resolve(destinationDir, "node_modules/@embedded-postgres"), { recursive: true, force: true });
  }
  writeFileSync(deployedPackagePath, `${JSON.stringify(stageBundledEsbuildOptionalDependencies(destinationDir,
    JSON.parse(readFileSync(deployedPackagePath, "utf8"))), null, 2)}\n`);
  writeFileSync(deployedPackagePath, `${JSON.stringify(stageBundledOpenCodeOptionalDependencies(destinationDir,
    JSON.parse(readFileSync(deployedPackagePath, "utf8"))), null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--docker-provider-graph") {
    const [, serverDirectory, architecture, ...extra] = process.argv.slice(2);
    if (!serverDirectory || !architecture || extra.length) throw new Error("Usage: prepare-bundled-package.mjs --docker-provider-graph <server-directory> <TARGETARCH>");
    console.log(JSON.stringify(materializeDockerProviderGraph(resolve(serverDirectory), architecture)));
    process.exit(0);
  }
  const [sourceDir, destinationDir] = process.argv.slice(2);
  if (!sourceDir || !destinationDir) {
    console.error("Usage: prepare-bundled-package.mjs <source-dir> <destination-dir>");
    process.exit(1);
  }
  prepareBundledPackage(resolve(sourceDir), resolve(destinationDir));
}

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratchParent = process.env.PAPERCLIP_RUN_SCRATCH_DIR
  ?? process.env.PAPERCLIP_SCRATCH_DIR
  ?? tmpdir();
await mkdir(scratchParent, { recursive: true });
const scratchRoot = await mkdtemp(join(scratchParent, "paperclip-package-consumer-"));
const artifactsRoot = resolve(scratchRoot, "artifacts");
const publicationRoot = process.env.PAPERCLIP_CLEAN_CONSUMER_OUTPUT_DIR === undefined
  ? undefined
  : resolve(process.env.PAPERCLIP_CLEAN_CONSUMER_OUTPUT_DIR);
const pnpmInvocation = resolvePnpmInvocation();
await mkdir(artifactsRoot, { recursive: true });

try {
  run("pnpm", ["run", "build:typescript"], runnerRoot);
  run("cargo", [
    "build",
    "--release",
    "--manifest-path",
    "runner/Cargo.toml",
    "--locked",
    "-p",
    "paperclip-runner-core",
    "--bin",
    "paperclip-runnerd",
  ], runnerRoot);
  const runnerTarball = await pack(runnerRoot, artifactsRoot);
  const runtimeDependencyTarballs = await packRunnerRuntimeDependencies(artifactsRoot);
  const runnerdArtifact = await stageRunnerdArtifact(artifactsRoot);
  const conformanceRecord = resolve(artifactsRoot, "paperclip-runner-consumer-conformance.json");
  const sourceCommit = (
    process.env.PAPERCLIP_SOURCE_COMMIT
    ?? capture("git", ["rev-parse", "HEAD"], runnerRoot)
  ).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("PAPERCLIP_SOURCE_COMMIT must be a full lowercase Git commit SHA");
  }

  await verifyRunnerConsumer({
    consumerRoot: resolve(scratchRoot, "runner-consumer"),
    runnerTarball,
    runtimeDependencyTarballs,
    runnerdArtifact,
    conformanceRecord,
    sourceCommit,
  });

  if (publicationRoot !== undefined) {
    await publishArtifacts({ publicationRoot, runnerTarball, runnerdArtifact, conformanceRecord });
    process.stdout.write(`Published clean-consumer artifacts at ${publicationRoot}\n`);
  }
  process.stdout.write("Clean-consumer pack/install checks passed for the runner root, evals, and testing exports.\n");
} finally {
  if (process.env.PAPERCLIP_KEEP_PACKAGE_CONSUMERS !== "1") {
    await rm(scratchRoot, { recursive: true, force: true });
  } else {
    process.stdout.write(`Kept clean-consumer scratch at ${scratchRoot}\n`);
  }
}

async function pack(packageRoot, destination) {
  const before = new Set(await readdir(destination));
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", destination], packageRoot, { quiet: true });
  const created = (await readdir(destination))
    .filter((entry) => entry.endsWith(".tgz") && !before.has(entry))
    .sort();
  if (created.length !== 1) {
    throw new Error(`Expected one tarball from ${packageRoot}, found ${created.join(", ") || "none"}`);
  }
  return resolve(destination, created[0]);
}

async function packRunnerRuntimeDependencies(destination) {
  const runnerManifest = JSON.parse(await readFile(resolve(runnerRoot, "package.json"), "utf8"));
  const overrides = {};
  const packed = new Map();
  const queued = new Set();
  const queue = [];

  const enqueue = async (packageRoot, overrideKey) => {
    const concreteRoot = await realpath(packageRoot);
    const manifest = JSON.parse(await readFile(resolve(concreteRoot, "package.json"), "utf8"));
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`Runtime dependency at ${concreteRoot} has no exact package identity`);
    }
    const identity = `${manifest.name}@${manifest.version}`;
    let tarball = packed.get(identity);
    if (tarball === undefined) {
      tarball = await pack(concreteRoot, destination);
      packed.set(identity, tarball);
    }
    overrides[overrideKey] = tarball;
    if (!queued.has(identity)) {
      queued.add(identity);
      queue.push({ root: concreteRoot, manifest });
    }
  };

  for (const packageName of Object.keys(runnerManifest.dependencies ?? {}).sort()) {
    await enqueue(resolve(runnerRoot, "node_modules", packageName), packageName);
  }
  while (queue.length > 0) {
    const current = queue.shift();
    const required = current.manifest.dependencies ?? {};
    const optional = current.manifest.optionalDependencies ?? {};
    const peers = current.manifest.peerDependencies ?? {};
    const optionalPeers = current.manifest.peerDependenciesMeta ?? {};
    for (const dependencyName of Object.keys({ ...required, ...optional, ...peers }).sort()) {
      const dependencyRoot = await resolveInstalledDependencyRoot(current.root, dependencyName);
      if (dependencyRoot === null) {
        if (dependencyName in optional || optionalPeers[dependencyName]?.optional === true) continue;
        throw new Error(`${current.manifest.name}@${current.manifest.version} dependency ${dependencyName} is not installed`);
      }
      await enqueue(
        dependencyRoot,
        `${current.manifest.name}@${current.manifest.version}>${dependencyName}`,
      );
    }
  }
  return overrides;
}

async function resolveInstalledDependencyRoot(packageRoot, dependencyName) {
  let cursor = packageRoot;
  while (true) {
    const candidate = resolve(cursor, "node_modules", dependencyName);
    try {
      return await realpath(candidate);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
  }
}

async function stageRunnerdArtifact(destination) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const source = resolve(runnerRoot, `runner/target/release/paperclip-runnerd${suffix}`);
  const executablePath = resolve(destination, `paperclip-runnerd-${process.platform}-${process.arch}${suffix}`);
  await copyFile(source, executablePath);
  if (process.platform !== "win32") await chmod(executablePath, 0o755);
  const bytes = await readFile(executablePath);
  return {
    executablePath,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    byteSize: bytes.byteLength,
    buildProfile: "release",
  };
}

function localOverrides(tarballs) {
  return Object.fromEntries(
    Object.entries(tarballs).map(([selector, tarball]) => [selector, `file:${tarball}`]),
  );
}

async function verifyRunnerConsumer({
  consumerRoot,
  runnerTarball,
  runtimeDependencyTarballs,
  runnerdArtifact,
  conformanceRecord,
  sourceCommit,
}) {
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(resolve(consumerRoot, "package.json"), `${JSON.stringify({
    name: "paperclip-runner-clean-consumer",
    private: true,
    type: "module",
    packageManager: "pnpm@9.15.4",
    dependencies: {
      "@paperclipai/paperclip-runner": `file:${runnerTarball}`,
    },
    pnpm: { overrides: localOverrides(runtimeDependencyTarballs) },
  }, null, 2)}\n`);
  await writeFile(resolve(consumerRoot, "verify.mjs"), `
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import * as runtime from "@paperclipai/paperclip-runner";
import * as evals from "@paperclipai/paperclip-runner/evals";
import * as testing from "@paperclipai/paperclip-runner/testing";

if ("MockControlPlaneAdapter" in runtime || "runControlPlanePortConformance" in runtime) {
  throw new Error("test helpers leaked through the runtime root");
}
if (typeof testing.MockControlPlaneAdapter !== "function") {
  throw new Error("deterministic mock is absent from ./testing");
}
const adapter = new testing.MockControlPlaneAdapter();
const report = await testing.runControlPlanePortConformance({
  port: adapter,
  start: () => adapter.start(),
  stop: () => adapter.stop(),
});
if (report.eventCount !== 3) throw new Error("packed conformance kit returned the wrong event count");

const nativeBundle = await evals.loadPaperclipNativeExecutionFixture();
if (nativeBundle.schema !== "paperclip-runner/native-execution/v1") {
  throw new Error("packed native execution fixture is unavailable");
}
if (nativeBundle.semanticTools.results[0]?.outcome !== "denied") {
  throw new Error("native execution fixture lost its rejected tool effect");
}

runtime.assertPaperclipRunnerCompatibility({
  consumer: "paperclip-runner-clean-consumer",
  components: { catalog: 1, protocol: 1, runnerClient: 1, controlPlaneAdapter: 1, testkit: 1 },
  requiredOperationIds: ["finish_task"],
  provider: { id: "clean-provider", supportedOperationIds: ["finish_task"] },
});

const driverConformance = await testing.runHarnessDriverConformance({
  driver: new testing.DeterministicHarnessDriver(),
});
if (!driverConformance.checks.transcriptCompleteness || driverConformance.semanticToolCallCount !== 1) {
  throw new Error("packed harness-driver conformance did not cover transcript/tools");
}

const runnerd = await evals.resolvePaperclipRunnerdArtifact({
  executablePath: process.env.PAPERCLIP_RUNNERD_ARTIFACT,
  expectedSha256: process.env.PAPERCLIP_RUNNERD_SHA256,
});
const evalCompatibility = evals.assertPaperclipRunnerEvalCompatibility({
  consumer: "paperclip-runner-clean-consumer",
  packageVersion: evals.PAPERCLIP_RUNNER_BUILD_METADATA.package.version,
  runnerd: runnerd.buildMetadata,
  nativeExecutionVersion: 1,
  prp: { minimumVersion: 1, maximumVersion: 1 },
  catalog: evals.PAPERCLIP_RUNNER_BUILD_METADATA.semanticCatalog,
  driver: {
    contractVersion: driverConformance.contractVersion,
    descriptor: driverConformance.descriptor,
    requiredCapabilities: ["typedEvents", "interruption", "usage", "dynamicTools"],
  },
});
if (evalCompatibility.negotiatedPrpVersion !== 1) {
  throw new Error("package/binary PRP negotiation returned the wrong version");
}
let mismatchFailedClosed = false;
try {
  evals.assertPaperclipRunnerEvalCompatibility({
    consumer: "incompatible-runner-clean-consumer",
    packageVersion: evals.PAPERCLIP_RUNNER_BUILD_METADATA.package.version,
    runnerd: { ...runnerd.buildMetadata, binaryContractVersion: 999 },
    nativeExecutionVersion: 1,
    prp: { minimumVersion: 1, maximumVersion: 1 },
    catalog: evals.PAPERCLIP_RUNNER_BUILD_METADATA.semanticCatalog,
    driver: {
      contractVersion: driverConformance.contractVersion,
      descriptor: driverConformance.descriptor,
      requiredCapabilities: [],
    },
  });
} catch (error) {
  mismatchFailedClosed = error?.code === "paperclip_runner_eval_incompatible"
    && error.issues?.some((issue) => issue.code === "binary_contract_version_mismatch");
}
if (!mismatchFailedClosed) {
  throw new Error("runnerd contract mismatch did not fail closed");
}

const normalized = {
  authorization: { outcome: "allowed" },
  state: { status: "done" },
  effects: [],
  audit: [],
};
const semanticConformance = await testing.runSemanticConformanceKit({
  vectors: [{ id: "finish", operationId: "finish_task", input: {} }],
  adapters: [
    { id: "mock", execute: async () => normalized },
    { id: "real", execute: async () => ({ audit: [], effects: [], state: { status: "done" }, authorization: { outcome: "allowed" } }) },
  ],
});

const packageArtifactPath = process.env.PAPERCLIP_RUNNER_PACKAGE_ARTIFACT;
const runnerdArtifactPath = process.env.PAPERCLIP_RUNNERD_ARTIFACT;
const packageBytes = await readFile(packageArtifactPath);
const runnerdBytes = await readFile(runnerdArtifactPath);
const packageStat = await stat(packageArtifactPath);
const runnerdStat = await stat(runnerdArtifactPath);
const runnerdDigest = "sha256:" + createHash("sha256").update(runnerdBytes).digest("hex");
if (runnerdDigest !== process.env.PAPERCLIP_RUNNERD_SHA256) {
  throw new Error("runnerd artifact digest changed after staging");
}

await writeFile(process.env.PAPERCLIP_CONFORMANCE_RECORD, JSON.stringify({
  schema: "paperclip-runner/clean-consumer-conformance/v1",
  recordedAt: new Date().toISOString(),
  sourceCommit: process.env.PAPERCLIP_SOURCE_COMMIT,
  platform: { os: process.platform, arch: process.arch },
  artifacts: {
    package: {
      filename: basename(packageArtifactPath),
      sha256: "sha256:" + createHash("sha256").update(packageBytes).digest("hex"),
      byteSize: packageStat.size,
    },
    runnerd: {
      filename: basename(runnerdArtifactPath),
      sha256: runnerdDigest,
      byteSize: runnerdStat.size,
      buildProfile: process.env.PAPERCLIP_RUNNERD_BUILD_PROFILE,
    },
  },
  consumer: {
    installMode: "offline-packed-artifact",
    imports: [
      "@paperclipai/paperclip-runner",
      "@paperclipai/paperclip-runner/evals",
      "@paperclipai/paperclip-runner/testing",
    ],
    appSourceTreeImports: false,
    providerCalls: 0,
  },
  checks: {
    packageExportsResolved: true,
    nativeExecutionFixture: {
      schema: nativeBundle.schema,
      rejectedToolEffectPreserved: true,
    },
    evalCompatibility,
    evalMismatchFailedClosed: mismatchFailedClosed,
    mockControlPlaneConformance: report,
    harnessDriverConformance: driverConformance,
    runnerdDigest: true,
    semanticConformance: {
      schema: semanticConformance.schema,
      rowCount: semanticConformance.rows.length,
      adapterIds: semanticConformance.rows[0]?.adapterIds ?? [],
    },
  },
}, null, 2) + "\\n");
`);
  installAndRun(consumerRoot, {
    PAPERCLIP_RUNNERD_ARTIFACT: runnerdArtifact.executablePath,
    PAPERCLIP_RUNNERD_SHA256: runnerdArtifact.sha256,
    PAPERCLIP_RUNNERD_BUILD_PROFILE: runnerdArtifact.buildProfile,
    PAPERCLIP_RUNNER_PACKAGE_ARTIFACT: runnerTarball,
    PAPERCLIP_CONFORMANCE_RECORD: conformanceRecord,
    PAPERCLIP_SOURCE_COMMIT: sourceCommit,
  });
}

async function publishArtifacts({ publicationRoot, runnerTarball, runnerdArtifact, conformanceRecord }) {
  await mkdir(publicationRoot, { recursive: true });
  const files = [runnerTarball, runnerdArtifact.executablePath, conformanceRecord];
  for (const file of files) await copyFile(file, resolve(publicationRoot, basename(file)));
  if (process.platform !== "win32") {
    await chmod(resolve(publicationRoot, basename(runnerdArtifact.executablePath)), 0o755);
  }
  const checksums = [];
  for (const file of files) {
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    checksums.push(`${digest}  ${basename(file)}`);
  }
  await writeFile(resolve(publicationRoot, "SHA256SUMS"), `${checksums.join("\n")}\n`);
}

function installAndRun(consumerRoot, extraEnv = {}) {
  run("pnpm", [
    "install",
    "--offline",
    "--ignore-scripts",
    "--lockfile=false",
    "--store-dir",
    resolve(consumerRoot, ".pnpm-store"),
    "--config.auto-install-peers=false",
    "--reporter=append-only",
  ], consumerRoot, { env: { NODE_ENV: "development" } });
  run(process.execPath, ["verify.mjs"], consumerRoot, { env: extraEnv });
}

function run(command, args, cwd, { quiet = false, env = {} } = {}) {
  const usesPnpm = command === "pnpm";
  const executable = usesPnpm ? pnpmInvocation.executable : command;
  const effectiveArgs = usesPnpm ? [...pnpmInvocation.prefixArgs, ...args] : args;
  const result = spawnSync(executable, effectiveArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true", ...env },
    stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    ...(quiet ? { maxBuffer: 32 * 1024 * 1024 } : {}),
  });
  if (result.status !== 0) {
    if (quiet) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    if (result.error !== undefined) process.stderr.write(`${String(result.error)}\n`);
    if (result.signal !== null) process.stderr.write(`Terminated by signal ${result.signal}\n`);
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
}

function resolvePnpmInvocation() {
  const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const corepackProbe = spawnSync(corepack, ["pnpm@9.15.4", "--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (corepackProbe.status === 0 && corepackProbe.stdout.trim() === "9.15.4") {
    return { executable: corepack, prefixArgs: ["pnpm@9.15.4"] };
  }
  const direct = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const directProbe = spawnSync(direct, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (directProbe.status === 0 && directProbe.stdout.trim() === "9.15.4") {
    return { executable: direct, prefixArgs: [] };
  }
  throw new Error("Clean-consumer verification requires pnpm 9.15.4 via corepack or PATH");
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
  return result.stdout;
}

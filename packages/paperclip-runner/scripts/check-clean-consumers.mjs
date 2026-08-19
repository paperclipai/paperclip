import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evalKernelRoot = resolve(runnerRoot, "../paperclip-eval-kernel");
const scratchParent = process.env.PAPERCLIP_RUN_SCRATCH_DIR
  ?? process.env.PAPERCLIP_SCRATCH_DIR
  ?? tmpdir();
await mkdir(scratchParent, { recursive: true });
const scratchRoot = await mkdtemp(join(scratchParent, "paperclip-package-consumers-"));
const artifactsRoot = resolve(scratchRoot, "artifacts");
const publicationRoot = process.env.PAPERCLIP_CLEAN_CONSUMER_OUTPUT_DIR === undefined
  ? undefined
  : resolve(process.env.PAPERCLIP_CLEAN_CONSUMER_OUTPUT_DIR);
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
  run("pnpm", ["run", "build"], evalKernelRoot);
  const runnerTarball = await pack(runnerRoot, artifactsRoot);
  const evalKernelTarball = await pack(evalKernelRoot, artifactsRoot);
  const runtimeDependencyTarballs = await packRunnerRuntimeDependencies(artifactsRoot);
  const runnerdArtifact = await stageRunnerdArtifact(artifactsRoot);
  const conformanceRecord = resolve(
    artifactsRoot,
    "paperclip-runner-evals-conformance.json",
  );
  const sourceCommit = (
    process.env.PAPERCLIP_SOURCE_COMMIT
    ?? capture("git", ["rev-parse", "HEAD"], runnerRoot)
  ).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("PAPERCLIP_SOURCE_COMMIT must be a full lowercase Git commit SHA");
  }

  await verifyEvalsConsumer(
    resolve(scratchRoot, "evals-consumer"),
    runnerTarball,
    runtimeDependencyTarballs,
    runnerdArtifact,
    conformanceRecord,
    sourceCommit,
  );
  await verifyAppDevConsumer(
    resolve(scratchRoot, "app-dev-consumer"),
    runnerTarball,
    evalKernelTarball,
    runtimeDependencyTarballs,
  );

  const runnerManifest = JSON.parse(await readFile(resolve(runnerRoot, "package.json"), "utf8"));
  const runtimeDependencies = {
    ...(runnerManifest.dependencies ?? {}),
    ...(runnerManifest.optionalDependencies ?? {}),
    ...(runnerManifest.peerDependencies ?? {}),
  };
  if ("@paperclipai/paperclip-eval-kernel" in runtimeDependencies) {
    throw new Error("runner tarball has a runtime dependency on Paperclip Evals");
  }
  if (publicationRoot !== undefined) {
    await publishArtifacts({
      publicationRoot,
      runnerTarball,
      runnerdArtifact,
      conformanceRecord,
    });
    process.stdout.write(`Published clean-consumer artifacts at ${publicationRoot}\n`);
  }
  process.stdout.write("Clean-consumer pack/install checks passed for Evals -> App package/release runnerd and App dev -> eval kernel.\n");
} finally {
  if (process.env.PAPERCLIP_KEEP_PACKAGE_CONSUMERS !== "1") {
    await rm(scratchRoot, { recursive: true, force: true });
  } else {
    process.stdout.write(`Kept clean-consumer scratch at ${scratchRoot}\n`);
  }
}

async function pack(packageRoot, destination) {
  const before = new Set(await readdir(destination));
  run("pnpm", ["pack", "--pack-destination", destination], packageRoot, { quiet: true });
  const created = (await readdir(destination))
    .filter((entry) => entry.endsWith(".tgz") && !before.has(entry))
    .sort();
  if (created.length !== 1) {
    throw new Error(`Expected one tarball from ${packageRoot}, found ${created.join(", ") || "none"}`);
  }
  return resolve(destination, created[0]);
}

async function packRunnerRuntimeDependencies(destination) {
  const ajvRoot = resolve(runnerRoot, "node_modules/ajv");
  const ajvModules = dirname(await realpath(ajvRoot));
  const packageNames = [
    "ajv",
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string",
  ];
  const tarballs = {};
  for (const packageName of packageNames) {
    const packageRoot = packageName === "ajv" ? ajvRoot : resolve(ajvModules, packageName);
    tarballs[packageName] = await pack(packageRoot, destination);
  }
  return tarballs;
}

async function stageRunnerdArtifact(destination) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const source = resolve(runnerRoot, `runner/target/release/paperclip-runnerd${suffix}`);
  const executablePath = resolve(
    destination,
    `paperclip-runnerd-${process.platform}-${process.arch}${suffix}`,
  );
  await copyFile(source, executablePath);
  if (process.platform !== "win32") await chmod(executablePath, 0o755);
  const bytes = await readFile(executablePath);
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return { executablePath, sha256, byteSize: bytes.byteLength, buildProfile: "release" };
}

function localOverrides(tarballs) {
  return Object.fromEntries(
    Object.entries(tarballs).map(([packageName, tarball]) => [packageName, `file:${tarball}`]),
  );
}

async function verifyEvalsConsumer(
  consumerRoot,
  runnerTarball,
  runtimeDependencyTarballs,
  runnerdArtifact,
  conformanceRecord,
  sourceCommit,
) {
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(resolve(consumerRoot, "package.json"), `${JSON.stringify({
    name: "paperclip-evals-clean-consumer",
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
const integration = evals.assertPaperclipRunnerEvalCompatibility({
  consumer: "paperclip-evals-clean-consumer",
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
if (integration.negotiatedPrpVersion !== 1) {
  throw new Error("package/binary PRP negotiation returned the wrong version");
}

runtime.assertPaperclipRunnerCompatibility({
  consumer: "paperclip-evals-clean-consumer",
  components: { catalog: 1, protocol: 1, runnerClient: 1, controlPlaneAdapter: 1, testkit: 1 },
  evalCorpusVersion: 1,
  requiredOperationIds: ["finish_task"],
  provider: { id: "clean-provider", supportedOperationIds: ["finish_task"] },
});
let failedExplicitly = false;
try {
  runtime.assertPaperclipRunnerCompatibility({
    consumer: "incompatible-provider",
    requiredOperationIds: ["finish_task"],
    provider: { id: "missing-finish", supportedOperationIds: [] },
  });
} catch (error) {
  failedExplicitly = error?.code === "paperclip_runner_incompatible"
    && error.issues?.[0]?.code === "provider_operation_unsupported";
}
if (!failedExplicitly) throw new Error("provider incompatibility did not fail explicitly");

let driverMismatchFailed = false;
try {
  evals.assertPaperclipRunnerEvalCompatibility({
    consumer: "incompatible-driver",
    packageVersion: evals.PAPERCLIP_RUNNER_BUILD_METADATA.package.version,
    runnerd: runnerd.buildMetadata,
    nativeExecutionVersion: 1,
    prp: { minimumVersion: 1, maximumVersion: 1 },
    catalog: evals.PAPERCLIP_RUNNER_BUILD_METADATA.semanticCatalog,
    driver: {
      contractVersion: 2,
      descriptor: driverConformance.descriptor,
      requiredCapabilities: [],
    },
  });
} catch (error) {
  driverMismatchFailed = error?.code === "paperclip_runner_eval_incompatible"
    && error.issues?.some((issue) => issue.code === "driver_contract_version_mismatch");
}
if (!driverMismatchFailed) throw new Error("driver mismatch did not fail explicitly");

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
const packageBytes = await readFile(packageArtifactPath);
const packageStat = await stat(packageArtifactPath);
const record = {
  schema: "paperclip-runner/evals-clean-consumer-conformance/v1",
  recordedAt: new Date().toISOString(),
  sourceCommit: process.env.PAPERCLIP_SOURCE_COMMIT,
  platform: { os: process.platform, arch: process.arch },
  artifactInputsOnly: true,
  artifacts: {
    package: {
      filename: basename(packageArtifactPath),
      packageName: evals.PAPERCLIP_RUNNER_BUILD_METADATA.package.name,
      packageVersion: evals.PAPERCLIP_RUNNER_BUILD_METADATA.package.version,
      sha256: "sha256:" + createHash("sha256").update(packageBytes).digest("hex"),
      byteSize: packageStat.size,
    },
    runnerd: {
      filename: basename(runnerd.executablePath),
      sha256: runnerd.sha256,
      byteSize: runnerd.byteSize,
      buildProfile: process.env.PAPERCLIP_RUNNERD_BUILD_PROFILE,
      buildMetadata: runnerd.buildMetadata,
    },
  },
  consumer: {
    installMode: "offline-packed-artifact",
    packageSpecifier: "file:" + basename(packageArtifactPath),
    runnerdLocator: "explicit-path-and-sha256",
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
    mockControlPlaneConformance: report,
    nativeExecutionFixture: {
      schema: nativeBundle.schema,
      rejectedToolEffectPreserved: true,
    },
    harnessDriverConformance: driverConformance,
    runnerdDigestAndMetadata: true,
    compatibilityNegotiation: integration,
    driverMismatchFailedClosed: driverMismatchFailed,
    providerMismatchFailedClosed: failedExplicitly,
    semanticConformance: {
      schema: semanticConformance.schema,
      rowCount: semanticConformance.rows.length,
      adapterIds: semanticConformance.rows[0]?.adapterIds ?? [],
    },
    transcriptComplete: driverConformance.checks.transcriptCompleteness,
  },
};
await writeFile(process.env.PAPERCLIP_CONFORMANCE_RECORD, JSON.stringify(record, null, 2) + "\\n");
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

async function publishArtifacts({
  publicationRoot,
  runnerTarball,
  runnerdArtifact,
  conformanceRecord,
}) {
  await mkdir(publicationRoot, { recursive: true });
  const files = [runnerTarball, runnerdArtifact.executablePath, conformanceRecord];
  for (const file of files) {
    await copyFile(file, resolve(publicationRoot, basename(file)));
  }
  if (process.platform !== "win32") {
    await chmod(
      resolve(publicationRoot, basename(runnerdArtifact.executablePath)),
      0o755,
    );
  }
  const checksums = [];
  for (const file of files) {
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    checksums.push(`${digest}  ${basename(file)}`);
  }
  await writeFile(resolve(publicationRoot, "SHA256SUMS"), `${checksums.join("\n")}\n`);
}

async function verifyAppDevConsumer(
  consumerRoot,
  runnerTarball,
  evalKernelTarball,
  runtimeDependencyTarballs,
) {
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(resolve(consumerRoot, "package.json"), `${JSON.stringify({
    name: "paperclip-app-dev-clean-consumer",
    private: true,
    type: "module",
    packageManager: "pnpm@9.15.4",
    dependencies: {
      "@paperclipai/paperclip-runner": `file:${runnerTarball}`,
    },
    devDependencies: {
      "@paperclipai/paperclip-eval-kernel": `file:${evalKernelTarball}`,
    },
    pnpm: { overrides: localOverrides(runtimeDependencyTarballs) },
  }, null, 2)}\n`);
  await writeFile(resolve(consumerRoot, "verify.mjs"), `
import {
  assertPaperclipRunnerCompatibility,
} from "@paperclipai/paperclip-runner";
import {
  PAPERCLIP_EVAL_KERNEL_COMPATIBILITY,
  runPaperclipEvalMatrix,
} from "@paperclipai/paperclip-eval-kernel";

if (PAPERCLIP_EVAL_KERNEL_COMPATIBILITY.apiVersion !== 1) {
  throw new Error("unexpected eval-kernel API version");
}
const results = await runPaperclipEvalMatrix({
  scenarios: [{ id: "finish", input: { expected: "done" } }],
  candidates: [{
    id: "runner-v1",
    config: { result: "done" },
    preflight: () => assertPaperclipRunnerCompatibility({
      consumer: "paperclip-app-dev-clean-consumer",
      components: { catalog: 1, protocol: 1, runnerClient: 1, controlPlaneAdapter: 1, testkit: 1 },
      evalCorpusVersion: 1,
      requiredOperationIds: ["finish_task"],
      provider: { id: "clean-provider", supportedOperationIds: ["finish_task"] },
    }),
  }],
  execute: async ({ candidate }) => candidate.config.result,
  score: ({ scenario, output }) => ({ passed: output === scenario.input.expected }),
});
if (results.length !== 1 || results[0].score.passed !== true) {
  throw new Error("packed eval kernel did not execute the dev-only matrix");
}
`);
  installAndRun(consumerRoot);
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
  const executable = usesPnpm
    ? (process.platform === "win32" ? "corepack.cmd" : "corepack")
    : command;
  const effectiveArgs = usesPnpm ? ["pnpm@9.15.4", ...args] : args;
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

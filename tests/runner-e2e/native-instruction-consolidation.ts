import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MatrixExecution } from "./types.js";
import { nativeCompletionDefinitionDigest } from "./native-completion-cases.js";
import { nativeCompletionPreflightEnvironment } from "./native-completion-admission.js";
import { inspectNativeCompletionSourceMetadata, inspectNativeCompletionRunnerd } from "./native-completion-git-source.mjs";

export const NATIVE_INSTRUCTION_SUITE = "native-instruction-consolidation";
export const NATIVE_INSTRUCTION_BASE_SHA = "2a8a99e4a5f69aa803b3f10b982f583e75a87042";
export const NATIVE_INSTRUCTION_DEFAULT_SHA256 = "c6318bf7e425cc0dd7acd4ff2905dab5c46ffddedef979afdf06720c82f6e95a";
export const NATIVE_INSTRUCTION_PREFLIGHT_ENV = "PAPERCLIP_NATIVE_INSTRUCTION_PREFLIGHT";
const root = resolve(import.meta.dirname, "../..");
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const OPENCODE_FEEDBACK_BASE_FILES = {
  "packages/paperclip-runner/src/backends/native-backend-factory.ts": "8ca5fdcecc13dc8749da5328a22154ec7590356fd4cb77380f802a3018af667c",
  "packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.ts": "a5bf84966846feab174d1ca94dda60cff06edb7cabb3d7d5d71e07d5a4af3912",
  "packages/paperclip-runner/src/cli/opencode-app-server-proxy.ts": "1969805c0d72ee7e4bdfc518fb8d31e6aedd4bda750a2922ec0f4d5c359dfbd6",
  "packages/paperclip-runner/src/cli/opencode-proxy-input.ts": "1102bea34dedfb4b4d2ce9ca8011e95f0fce227a6a0b9d2993ad08df00b4e433",
} as const;
export const NATIVE_INSTRUCTION_VARIANTS = {
  baseline: {
    ...OPENCODE_FEEDBACK_BASE_FILES,
    "packages/paperclip-runner/src/backends/runtime-context.ts": "e7c46e81cc9c93f9a4f805b5091ef08c59ea70c62f208cfda70d6edeed363898",
    "packages/paperclip-runner/src/backends/codex-native-backend.ts": "f276d436391c9e2f0a7e58ce1302b5c9f1a39ac01c148be257f9d455515a31b9",
    "packages/paperclip-runner/src/backends/opencode-native-backend.ts": "d54ddde3a3fdffcda3490d813d27b3b4891448e11cd05f61f9bb4b292d9fd6c2",
    "server/src/services/native-runtime/paperclip-runner-tool-authority.ts": "2da6963c690a3988bf2617d39e85025600b12a056a61c7b528c3d94ac636f777",
    "server/src/services/native-runtime/native-completion-feedback.ts": "72a8da837e93d1ab6f732bc88cc05de784ed771ab2f538ca1cf4768864cc678b",
    "ui/src/lib/issue-reference.ts": "ed965e30b6221a455e1dec4c6e51b1659b122828b70c289eeb0d95d9c897d242",
    "ui/src/components/MarkdownBody.tsx": "07543156b81e51e72cfc77262f135bdb19eaa6bcccf6a3aef60c20faddcca759",
  },
  candidate: {
    ...OPENCODE_FEEDBACK_BASE_FILES,
    "packages/paperclip-runner/src/backends/runtime-context.ts": "cae9075fac25f168972c2be4ddb58052ef2940554458e2757d88a5d0e39805c2",
    "packages/paperclip-runner/src/backends/codex-native-backend.ts": "affecc515a623e0dfeb338f553ea53ebb7d18baa3d13e4395d17b21000dbee93",
    "packages/paperclip-runner/src/backends/opencode-native-backend.ts": "d5dc4cc2c06b37d22be47c9f15f828c06b439d8241a8d34498ca4339273eed96",
    "server/src/services/native-runtime/paperclip-runner-tool-authority.ts": "2da6963c690a3988bf2617d39e85025600b12a056a61c7b528c3d94ac636f777",
    "server/src/services/native-runtime/native-completion-feedback.ts": "72a8da837e93d1ab6f732bc88cc05de784ed771ab2f538ca1cf4768864cc678b",
    "ui/src/lib/issue-reference.ts": "ed965e30b6221a455e1dec4c6e51b1659b122828b70c289eeb0d95d9c897d242",
    "ui/src/components/MarkdownBody.tsx": "07543156b81e51e72cfc77262f135bdb19eaa6bcccf6a3aef60c20faddcca759",
  },
  corrected: {
    ...OPENCODE_FEEDBACK_BASE_FILES,
    "packages/paperclip-runner/src/backends/runtime-context.ts": "bbdab79c5b1bd57c4ddbc44edfe745b40eb694aa28a465452964109aedd6104b",
    "packages/paperclip-runner/src/backends/codex-native-backend.ts": "affecc515a623e0dfeb338f553ea53ebb7d18baa3d13e4395d17b21000dbee93",
    "packages/paperclip-runner/src/backends/opencode-native-backend.ts": "d5dc4cc2c06b37d22be47c9f15f828c06b439d8241a8d34498ca4339273eed96",
    "server/src/services/native-runtime/paperclip-runner-tool-authority.ts": "d2360cdaa63902cbf0c6a6109da452ba7e0b2a5aaa76ee5cab9c63b4bf12e584",
    "server/src/services/native-runtime/native-completion-feedback.ts": "72a8da837e93d1ab6f732bc88cc05de784ed771ab2f538ca1cf4768864cc678b",
    "ui/src/lib/issue-reference.ts": "ed965e30b6221a455e1dec4c6e51b1659b122828b70c289eeb0d95d9c897d242",
    "ui/src/components/MarkdownBody.tsx": "07543156b81e51e72cfc77262f135bdb19eaa6bcccf6a3aef60c20faddcca759",
  },
  feedback: {
    ...OPENCODE_FEEDBACK_BASE_FILES,
    "packages/paperclip-runner/src/backends/runtime-context.ts": "bbdab79c5b1bd57c4ddbc44edfe745b40eb694aa28a465452964109aedd6104b",
    "packages/paperclip-runner/src/backends/codex-native-backend.ts": "affecc515a623e0dfeb338f553ea53ebb7d18baa3d13e4395d17b21000dbee93",
    "packages/paperclip-runner/src/backends/opencode-native-backend.ts": "d5dc4cc2c06b37d22be47c9f15f828c06b439d8241a8d34498ca4339273eed96",
    "server/src/services/native-runtime/paperclip-runner-tool-authority.ts": "d2360cdaa63902cbf0c6a6109da452ba7e0b2a5aaa76ee5cab9c63b4bf12e584",
    "server/src/services/native-runtime/native-completion-feedback.ts": "1f9da911ec5107c6b7543bc1b4134fc74597a29af6ed40101a895045a9e26ce0",
    "ui/src/lib/issue-reference.ts": "ab578752acc7e185333cb2b701f6db71cedbb44675db042f78fa88417e7b2ddf",
    "ui/src/components/MarkdownBody.tsx": "f3608614b143667f7dba087be81fd1449e4eac268a203e41256d1c99691c2541",
  },
  opencodeFeedback: {
    "packages/paperclip-runner/src/backends/runtime-context.ts": "bbdab79c5b1bd57c4ddbc44edfe745b40eb694aa28a465452964109aedd6104b",
    "packages/paperclip-runner/src/backends/codex-native-backend.ts": "affecc515a623e0dfeb338f553ea53ebb7d18baa3d13e4395d17b21000dbee93",
    "packages/paperclip-runner/src/backends/opencode-native-backend.ts": "d5dc4cc2c06b37d22be47c9f15f828c06b439d8241a8d34498ca4339273eed96",
    "server/src/services/native-runtime/paperclip-runner-tool-authority.ts": "d2360cdaa63902cbf0c6a6109da452ba7e0b2a5aaa76ee5cab9c63b4bf12e584",
    "server/src/services/native-runtime/native-completion-feedback.ts": "1f9da911ec5107c6b7543bc1b4134fc74597a29af6ed40101a895045a9e26ce0",
    "ui/src/lib/issue-reference.ts": "ab578752acc7e185333cb2b701f6db71cedbb44675db042f78fa88417e7b2ddf",
    "ui/src/components/MarkdownBody.tsx": "f3608614b143667f7dba087be81fd1449e4eac268a203e41256d1c99691c2541",
    "packages/paperclip-runner/src/backends/native-backend-factory.ts": "63c8aee5548bc1b711a8b92bc348a00b6a7454d7815757380fb719988a90237f",
    "packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.ts": "9eb9f0aa7336011dc9a28cfec10a7e3eac568923c0f69be9771d71a51b826ba6",
    "packages/paperclip-runner/src/cli/opencode-app-server-proxy.ts": "6f84af59e2a5e03b2eac48b094da3dfcbf213fe727350c79fbbef4cc554f03d2",
    "packages/paperclip-runner/src/cli/opencode-proxy-input.ts": "a7bf61c79047bf1aa205b32bbecc962ade4934ebac1fbbb5bcaa3a404f868ce7",
  },
  opencodeFeedbackSettlement: {
    "packages/paperclip-runner/src/backends/runtime-context.ts": "bbdab79c5b1bd57c4ddbc44edfe745b40eb694aa28a465452964109aedd6104b",
    "packages/paperclip-runner/src/backends/codex-native-backend.ts": "affecc515a623e0dfeb338f553ea53ebb7d18baa3d13e4395d17b21000dbee93",
    "packages/paperclip-runner/src/backends/opencode-native-backend.ts": "d5dc4cc2c06b37d22be47c9f15f828c06b439d8241a8d34498ca4339273eed96",
    "server/src/services/native-runtime/paperclip-runner-tool-authority.ts": "d2360cdaa63902cbf0c6a6109da452ba7e0b2a5aaa76ee5cab9c63b4bf12e584",
    "server/src/services/native-runtime/native-completion-feedback.ts": "1f9da911ec5107c6b7543bc1b4134fc74597a29af6ed40101a895045a9e26ce0",
    "ui/src/lib/issue-reference.ts": "ab578752acc7e185333cb2b701f6db71cedbb44675db042f78fa88417e7b2ddf",
    "ui/src/components/MarkdownBody.tsx": "f3608614b143667f7dba087be81fd1449e4eac268a203e41256d1c99691c2541",
    "packages/paperclip-runner/src/backends/native-backend-factory.ts": "63c8aee5548bc1b711a8b92bc348a00b6a7454d7815757380fb719988a90237f",
    "packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.ts": "e1b40e56cb05f3851f42ebf3d94be6aca8f0a2025820ddfd15ca01439d9eefb6",
    "packages/paperclip-runner/src/cli/opencode-app-server-proxy.ts": "6f84af59e2a5e03b2eac48b094da3dfcbf213fe727350c79fbbef4cc554f03d2",
    "packages/paperclip-runner/src/cli/opencode-proxy-input.ts": "a7bf61c79047bf1aa205b32bbecc962ade4934ebac1fbbb5bcaa3a404f868ce7",
  },
  opencodeFeedbackResponses: {
    "packages/paperclip-runner/src/backends/runtime-context.ts": "bbdab79c5b1bd57c4ddbc44edfe745b40eb694aa28a465452964109aedd6104b",
    "packages/paperclip-runner/src/backends/codex-native-backend.ts": "affecc515a623e0dfeb338f553ea53ebb7d18baa3d13e4395d17b21000dbee93",
    "packages/paperclip-runner/src/backends/opencode-native-backend.ts": "d5dc4cc2c06b37d22be47c9f15f828c06b439d8241a8d34498ca4339273eed96",
    "server/src/services/native-runtime/paperclip-runner-tool-authority.ts": "d2360cdaa63902cbf0c6a6109da452ba7e0b2a5aaa76ee5cab9c63b4bf12e584",
    "server/src/services/native-runtime/native-completion-feedback.ts": "1f9da911ec5107c6b7543bc1b4134fc74597a29af6ed40101a895045a9e26ce0",
    "ui/src/lib/issue-reference.ts": "ab578752acc7e185333cb2b701f6db71cedbb44675db042f78fa88417e7b2ddf",
    "ui/src/components/MarkdownBody.tsx": "f3608614b143667f7dba087be81fd1449e4eac268a203e41256d1c99691c2541",
    "packages/paperclip-runner/src/backends/native-backend-factory.ts": "63c8aee5548bc1b711a8b92bc348a00b6a7454d7815757380fb719988a90237f",
    "packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.ts": "e1b40e56cb05f3851f42ebf3d94be6aca8f0a2025820ddfd15ca01439d9eefb6",
    "packages/paperclip-runner/src/cli/opencode-app-server-proxy.ts": "48b6a672bdd63297ef773736e9768cbc5a968a371e85c9356f7733e4d39282a0",
    "packages/paperclip-runner/src/cli/opencode-proxy-input.ts": "a7bf61c79047bf1aa205b32bbecc962ade4934ebac1fbbb5bcaa3a404f868ce7",
  },
} as const;

// Admission explicitly binds every changed production path as well as comparison setup.
const comparisonFiles = new Set([
  ...Object.keys(NATIVE_INSTRUCTION_VARIANTS.baseline),
  "packages/paperclip-runner/src/backends/runtime-context.test.ts",
  "packages/paperclip-runner/src/backends/native-backend-factory.test.ts",
  "packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.test.ts",
  "packages/paperclip-runner/src/cli/opencode-proxy-completion.test.ts",
  "packages/paperclip-runner/src/cli/opencode-proxy-input.test.ts",
  "packages/paperclip-runner/src/live/runnerd-codex-transport.test.ts",
  "packages/paperclip-runner/test/fixtures/fake-opencode-server.mjs",
  "packages/paperclip-runner/src/backends/native-instruction-measurement.test.ts",
  "tests/runner-e2e/native-instruction-consolidation.ts",
  "tests/runner-e2e/native-instruction-consolidation.test.ts",
  "tests/runner-e2e/native-completion-git-source.d.mts",
  "tests/runner-e2e/native-completion-defaults.ts",
  "tests/runner-e2e/native-completion-defaults.test.ts",
  "tests/runner-e2e/native-completion-cases.ts", "tests/runner-e2e/native-completion-scoring.ts",
  "tests/runner-e2e/native-completion-scoring.test.ts", "tests/runner-e2e/native-completion-content.ts",
  "tests/runner-e2e/native-completion-content.test.ts",
  "server/src/services/native-runtime/paperclip-runner-tool-authority.test.ts",
  "server/src/services/native-runtime/native-completion-feedback.test.ts",
  "ui/src/lib/issue-reference.test.ts", "ui/src/components/MarkdownBody.test.tsx",
  "tests/runner-e2e/catalog.ts", "tests/runner-e2e/catalog.test.ts", "tests/runner-e2e/launch.ts",
  "tests/runner-e2e/runner.spec.ts", "tests/runner-e2e/live-fixtures.ts",
  "tests/runner-e2e/README.md", "doc/evals.md",
  "doc/plans/2026-10-03-native-completion-consolidation.md",
  "doc/plans/2026-10-04-native-completion-answer-fix.md",
]);
const git = (...args: string[]) => execFileSync("git", ["--no-replace-objects", ...args], {
  cwd: root, encoding: "utf8", timeout: 60_000,
  env: nativeCompletionPreflightEnvironment(process.env),
}).trim();

export function assertNativeInstructionLineage(sourceSha: string, run = git, hosted = process.env.GITHUB_ACTIONS === "true") {
  try { run("merge-base", "--is-ancestor", NATIVE_INSTRUCTION_BASE_SHA, sourceSha); }
  catch (error) {
    if (!hosted || run("rev-parse", "--is-shallow-repository") !== "true"
      || !/^[a-f0-9]{40}$/.test(sourceSha)) throw error;
    // Fetch only this immutable public source, with no provider keys or Git credentials.
    // The final ancestry/diff gates are identical to the full-history local gates.
    let ancestryError = error;
    for (const depth of [8, 32, 128]) {
      run("-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", `--depth=${depth}`,
        "https://github.com/paperclipai/paperclip.git", sourceSha);
      if (run("rev-parse", "HEAD") !== sourceSha) throw new Error("Source changed during ancestry hydration");
      try {
        run("merge-base", "--is-ancestor", NATIVE_INSTRUCTION_BASE_SHA, sourceSha);
        return;
      } catch (missingAncestor) {
        ancestryError = missingAncestor;
      }
    }
    throw ancestryError;
  }
}

export function nativeInstructionVariant(read = (file: string) => readFileSync(join(root, file))) {
  const matches = Object.entries(NATIVE_INSTRUCTION_VARIANTS).filter(([, files]) =>
    Object.entries(files).every(([file, digest]) => hash(read(file)) === digest));
  if (matches.length !== 1) throw new Error("Mixed or unknown native instruction source");
  return matches[0]![0];
}

export function nativeInstructionDefinitionDigest() {
  return hash(nativeCompletionDefinitionDigest() + hash(readFileSync(new URL(import.meta.url)))
    + hash(readFileSync(join(root, "tests/runner-e2e/native-completion-git-source.mjs")))
    + hash(readFileSync(join(root, "packages/paperclip-runner/src/backends/native-instruction-measurement.test.ts"))));
}

export function assertNativeInstructionSelection(executions: readonly MatrixExecution[]) {
  for (const execution of executions.filter(value => value.suite.id === NATIVE_INSTRUCTION_SUITE)) {
    if (!['runner-codex', 'runner-acpx-claude', 'runner-opencode'].includes(execution.profile.id)
      || execution.profile.generation !== "native" || execution.environment.id !== "local"
      || execution.profile.qualificationCandidate !== undefined || execution.task.expectedRunCount !== 1
      || (execution.task.minimumExpectedRunCount !== undefined && execution.task.minimumExpectedRunCount !== 1)
      || !['assigned-skill-explicit-invocation', 'native-blocked-report'].includes(execution.task.id)
      || execution.task.automaticRetryPolicy !== "single_attempt"
      || execution.id !== `${NATIVE_INSTRUCTION_SUITE}.${execution.profile.id}.local.${execution.task.id}`
      || execution.suite.manualOnly !== true || execution.suite.expectedMatrixSize !== 6
      || execution.suite.tasks.length !== 2
      || !['assigned-skill-explicit-invocation', 'native-blocked-report'].every(id =>
        execution.suite.tasks.filter(task => task.id === id && task.expectedRunCount === 1
          && task.automaticRetryPolicy === "single_attempt").length === 1)) {
      throw new Error("Native instruction comparison requires the declared local single-attempt cells");
    }
  }
}

function sourceReceipt() {
  const sourceSha = git("rev-parse", "HEAD");
  const requestedSource = process.env.PAPERCLIP_RUNNER_E2E_SOURCE_SHA?.trim();
  if (requestedSource && requestedSource !== sourceSha) throw new Error("Native instruction source differs from requested immutable revision");
  assertNativeInstructionLineage(sourceSha);
  const metadata = inspectNativeCompletionSourceMetadata({ repositoryRoot: root,
    sourceFiles: [...comparisonFiles], baseSha: NATIVE_INSTRUCTION_BASE_SHA, variant: nativeInstructionVariant() });
  if (!metadata.immutable || !metadata.layering || metadata.sourceMetadataErrors.length)
    throw new Error(`Native instruction comparison requires clean committed source: ${metadata.sourceMetadataErrors.join("; ")}`);
  const changed = git("diff", "--name-only", NATIVE_INSTRUCTION_BASE_SHA, sourceSha).split("\n").filter(Boolean);
  if (changed.some(file => !comparisonFiles.has(file))) throw new Error("Native instruction comparison contains unrelated source changes");
  return { sourceSha, sourceTree: git("rev-parse", "HEAD^{tree}"), variant: nativeInstructionVariant(),
    fixtureDigest: nativeInstructionDefinitionDigest(), sourceMetadata: metadata.sourceMetadata,
    sourceMetadataFingerprint: metadata.sourceMetadataFingerprint };
}

function buildFingerprint() {
  const digest = createHash("sha256");
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) { const bytes = readFileSync(join(root, file)); digest.update(JSON.stringify([file, bytes.length])).update(bytes); }
      else throw new Error(`Unexpected native build entry: ${file}`);
    }
  };
  visit("packages/paperclip-runner/dist");
  return digest.digest("hex");
}

function runnerdProof(source: ReturnType<typeof sourceReceipt>) {
  const proof = inspectNativeCompletionRunnerd({ repositoryRoot: root, sourceSha: source.sourceSha,
    sourceFingerprint: hash(JSON.stringify([source.sourceTree, source.fixtureDigest])),
    environment: nativeCompletionPreflightEnvironment(process.env) });
  if (!proof.passed) throw new Error(`Native instruction runnerd admission failed: ${proof.errors.join("; ")}`);
  return proof;
}

export function validateNativeInstructionMeasurement(measurement: {
  schema: string; sourceSha: string; sourceDirty: boolean; providerCalls: number; fixtureSha256: string;
  sourceHashes: Record<string, string>; receipts: Array<{ provider: string; schema: string; phase: string }>;
  directOpenCodeReceipts?: Array<{ provider: string; schema: string; phase: string }>;
}, source: { sourceSha: string; variant: string }) {
  const expected = ['codex', 'acpx', 'opencode'].flatMap(provider => ['v4', 'v5'].flatMap(schema =>
    ['start', 'resume', 'continuation'].map(phase => `${provider}/${schema}/${phase}`))).sort();
  const actual = measurement.receipts.map(value => `${value.provider}/${value.schema}/${value.phase}`).sort();
  const files = NATIVE_INSTRUCTION_VARIANTS[source.variant as keyof typeof NATIVE_INSTRUCTION_VARIANTS];
  const directExpected = ["v4", "v5"].flatMap(schema => ["start", "resume", "continuation"].map(phase => `opencode/${schema}/${phase}`)).sort();
  const directActual = measurement.directOpenCodeReceipts?.map(value => `${value.provider}/${value.schema}/${value.phase}`).sort();
  if (measurement.schema !== "paperclip.native-instruction-measurement.v2"
    || JSON.stringify(directActual) !== JSON.stringify(directExpected)
    || measurement.sourceSha !== source.sourceSha || measurement.sourceDirty !== false || measurement.providerCalls !== 0
    || measurement.fixtureSha256 !== hash(readFileSync(join(root, "packages/paperclip-runner/src/backends/native-instruction-measurement.test.ts")))
    || JSON.stringify(actual) !== JSON.stringify(expected) || !files
    || Object.entries(files).some(([file, digest]) => measurement.sourceHashes[file.split('/').at(-1)!] !== digest))
    throw new Error("Invalid or incomplete native instruction measurement");
}

export function prepareNativeInstructionPreflight(directory: string) {
  const source = sourceReceipt();
  const build = (script: string, file: string) => {
    const log = execFileSync("pnpm", ["--filter", "@paperclipai/paperclip-runner", script], {
      cwd: root, timeout: 10 * 60_000, env: nativeCompletionPreflightEnvironment(process.env), maxBuffer: 8 * 1024 * 1024,
    });
    writeFileSync(join(directory, file), log);
    return { executed: true, exitCode: 0, file, sha256: hash(log) };
  };
  const sdkBuild = build("build:typescript", "native-instruction-sdk-build.txt");
  const nativeBuild = process.env.GITHUB_ACTIONS === "true"
    ? { executed: false, reuse: "trusted_same_run_build", calibration: "not_executed" }
    : build("build:runner-binaries", "native-instruction-runnerd-build.txt");
  const runnerd = runnerdProof(source), buildSha256 = buildFingerprint();
  const measurementPath = join(directory, "native-instruction-measurement.json");
  execFileSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "src/backends/native-instruction-measurement.test.ts"], {
    cwd: join(root, "packages/paperclip-runner"), timeout: 60_000,
    env: { ...nativeCompletionPreflightEnvironment(process.env), PAPERCLIP_NATIVE_INSTRUCTION_REPORT: measurementPath }, stdio: "inherit",
  });
  const measurement = JSON.parse(readFileSync(measurementPath, "utf8"));
  validateNativeInstructionMeasurement(measurement, source);
  if (JSON.stringify(sourceReceipt()) !== JSON.stringify(source)) throw new Error("Source changed during native instruction admission");
  const output = join(directory, "native-instruction-preflight.json");
  writeFileSync(output, `${JSON.stringify({ schema: "paperclip.native-instruction-preflight.v1", ...source,
    measurementPath, measurementSha256: hash(readFileSync(measurementPath)),
    sdkBuild, nativeBuild, runnerd, buildSha256, providerCalls: 0, live: "not_run" }, null, 2)}\n`);
  return output;
}

export function verifyNativeInstructionPreflight(path: string | undefined) {
  if (!path) throw new Error("Missing native instruction source admission");
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  const source = sourceReceipt();
  if (receipt.schema !== "paperclip.native-instruction-preflight.v1"
    || receipt.sourceSha !== source.sourceSha || receipt.variant !== source.variant
    || receipt.sourceTree !== source.sourceTree || receipt.sourceMetadataFingerprint !== source.sourceMetadataFingerprint
    || receipt.fixtureDigest !== source.fixtureDigest
    || receipt.providerCalls !== 0 || receipt.live !== "not_run" || receipt.sdkBuild?.executed !== true || receipt.sdkBuild?.exitCode !== 0
    || receipt.sdkBuild.sha256 !== hash(readFileSync(join(receipt.measurementPath, "..", receipt.sdkBuild.file)))
    || receipt.buildSha256 !== buildFingerprint() || JSON.stringify(receipt.runnerd) !== JSON.stringify(runnerdProof(source))
    || (process.env.GITHUB_ACTIONS === "true"
      ? receipt.nativeBuild?.executed !== false || receipt.nativeBuild.reuse !== "trusted_same_run_build" || receipt.nativeBuild.calibration !== "not_executed"
      : receipt.nativeBuild?.executed !== true || receipt.nativeBuild.exitCode !== 0
        || receipt.nativeBuild.sha256 !== hash(readFileSync(join(receipt.measurementPath, "..", receipt.nativeBuild.file))))
    || receipt.measurementSha256 !== hash(readFileSync(receipt.measurementPath)))
    throw new Error("Stale or mismatched native instruction source admission");
  validateNativeInstructionMeasurement(JSON.parse(readFileSync(receipt.measurementPath, "utf8")), source);
  return receipt;
}

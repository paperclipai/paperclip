import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import pins from "./sdk-canary-build-pins.json" with { type: "json" };
import inputs from "./source-sdk-public-inputs.json" with { type: "json" };
import { verifySdkPublicSource } from "./source-sdk-public-type.js";
import { verifyRetainedSourceSdk } from "./source-sdk-evidence.js";
import { chatCatalogCaseFingerprint, normalizedChatCatalogExecution } from "./chat-catalog-fingerprint.js";
import { findChatCatalogCase } from "./chat-catalog-registry.js";
import { CHAT_OPENCODE_MODEL, CHAT_OPENCODE_PROFILE, reviewedChatProfile } from "./chat-runtime-profile.js";
import type { MatrixExecution } from "./types.js";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function fail(): never { throw new Error("SDK canary pre-fixture prerequisite is unqualified"); }
export const SDK_CANARY = "chat-features.runner-opencode.local.plugins.use-plugin-tool";
type Fingerprint = ReturnType<typeof chatCatalogCaseFingerprint>;
interface FileIdentity { file: string; size: number; sha256: string }
export interface SdkCanaryBuildObservation {
  sourceRevision: string; inputFiles: number; gitInputFiles: number; frozenInputManifestSha256: string; copiedInputManifestSha256: string;
  publicInputsFileSha256: string; helperSha256: string; lockSha256: string; compilerPackageSha256: string;
  compiledFiles: number; compiledManifestSha256: string; retainedManifestSha256: string;
  certificates: typeof pins.certificates;
}
export function assertSdkCanaryBuild(observed: SdkCanaryBuildObservation, expected = pins) {
  if (!/^[a-f0-9]{40}$/.test(observed.sourceRevision)) fail();
  for (const key of ["inputFiles", "gitInputFiles", "frozenInputManifestSha256", "copiedInputManifestSha256", "publicInputsFileSha256", "helperSha256", "lockSha256", "compilerPackageSha256", "compiledFiles", "compiledManifestSha256"] as const)
    if (observed[key] !== expected[key]) fail();
  if (observed.retainedManifestSha256 !== expected.compiledManifestSha256 || JSON.stringify(observed.certificates) !== JSON.stringify(expected.certificates)) fail();
}
export async function sdkCanaryOutputManifest(root: string) {
  const files: FileIdentity[] = []; let total = 0;
  const visit = async (relative: string) => {
    const file = path.join(root, relative), info = await lstat(file);
    if (info.isSymbolicLink() || await realpath(file) !== file) fail();
    if (info.isDirectory()) { for (const child of await readdir(file)) await visit(`${relative}/${child}`); }
    else {
      if (!info.isFile() || info.size > 8 * 1024 * 1024 || files.length >= 4096 || (total += info.size) > 64 * 1024 * 1024) fail();
      const bytes = await readFile(file); files.push({ file: relative, size: bytes.length, sha256: hash(bytes) });
    }
  };
  for (const certificate of pins.certificates) await visit(certificate.target);
  return files.sort((a, b) => a.file.localeCompare(b.file));
}
export async function captureSdkCanaryBuild(input: { repositoryRoot: string; temporaryRoot: string; sourceRevision: string | null; secrets: readonly string[] }) {
  if (!input.sourceRevision || await realpath(input.repositoryRoot) !== input.repositoryRoot) fail();
  const source = await verifySdkPublicSource(input.repositoryRoot);
  const publicInputsFileSha256 = hash(await readFile(path.join(input.repositoryRoot, "tests/runner-e2e/source-sdk-public-inputs.json")));
  const copied = [];
  for (const [file, gitBlobSha1] of Object.entries(inputs.inputs)) {
    const bytes = await readFile(path.join(input.repositoryRoot, file));
    copied.push({ path: file, bytes: bytes.length, sha256: hash(bytes), gitBlobSha1, restoredLockOverlay: file === "pnpm-lock.yaml" });
  }
  copied.sort((a, b) => a.path.localeCompare(b.path));
  const retained = await verifyRetainedSourceSdk(input.temporaryRoot, SDK_CANARY, input.sourceRevision, input.secrets, input.repositoryRoot);
  if (retained.receipt.schema !== "paperclip.source-plugin-sdk/v2" || retained.receipt.scanAudit?.bounded !== true || retained.receipt.scanAudit.suppressedFindings !== 0
    || !Array.isArray(retained.receipt.certifiedTargets) || retained.receipt.certifiedTargets.length !== pins.certificates.length) fail();
  const files = await sdkCanaryOutputManifest(input.repositoryRoot);
  const retainedFiles = retained.files.filter(row => row.file !== "receipt.json").map(({ file, size, sha256 }) => ({ file, size, sha256 })).sort((a, b) => a.file.localeCompare(b.file));
  const certificates = [];
  for (const expected of pins.certificates) {
    const marker = await readFile(path.join(input.repositoryRoot, expected.target, ".paperclip-build-complete"));
    const certificate = JSON.parse(marker.toString("utf8"));
    const saved = retained.receipt.certifiedTargets.find(row => row.directory === expected.target);
    if (saved?.sources !== certificate.sources || saved?.outputs !== certificate.outputs) fail();
    certificates.push({ target: expected.target, sources: certificate.sources, outputs: certificate.outputs, markerSha256: hash(marker) });
  }
  const observed: SdkCanaryBuildObservation = { sourceRevision: input.sourceRevision, inputFiles: copied.length, gitInputFiles: copied.length - 1,
    frozenInputManifestSha256: hash(JSON.stringify({ frozenRevision: "cb31ebccf0411f3e260159b1d39e6c047a39f4e9", inputs: inputs.inputs, schema: "paperclip.sdk-diagnostic-frozen-inputs/v1" })),
    copiedInputManifestSha256: hash(JSON.stringify(copied)), publicInputsFileSha256,
    helperSha256: hash(await readFile(path.join(input.repositoryRoot, "scripts/ensure-plugin-build-deps.mjs"))),
    lockSha256: source.identity.lockSha256, compilerPackageSha256: source.identity.compilerPackageSha256,
    compiledFiles: files.length, compiledManifestSha256: hash(JSON.stringify(files)), retainedManifestSha256: hash(JSON.stringify(retainedFiles)), certificates };
  if (retained.receipt.buildHelperSha256 !== observed.helperSha256 || retained.receipt.lockSha256 !== observed.lockSha256) fail();
  assertSdkCanaryBuild(observed); return observed;
}
function completeFingerprint(fingerprint: Fingerprint) {
  if (!fingerprint || fingerprint.fingerprintKind !== "complete-execution-and-oracle-closure" || !hex(fingerprint.digest)
    || fingerprint.definitionDigest !== fingerprint.digest || fingerprint.graderDigest !== fingerprint.digest || !Array.isArray(fingerprint.sources) || !fingerprint.sources.length
    || fingerprint.sources.some(row => !row.file || !hex(row.sha256)) || new Set(fingerprint.sources.map(row => row.file)).size !== fingerprint.sources.length
    || !fingerprint.sources.some(row => row.file === "packages/plugins/sdk/dist/index.js")) fail();
}
const entered = new WeakSet<MatrixExecution>();
const fingerprints = new WeakMap<MatrixExecution, Fingerprint>();
export async function withSdkCanaryPreFixture<T>(input: { execution: MatrixExecution; sourceRevision: string | null;
  capture(): Promise<{ build: SdkCanaryBuildObservation; fingerprint: Fingerprint }>;
  retain(proof: unknown): Promise<void>; fixtures(): Promise<T>;
}) {
  if (input.execution.id !== SDK_CANARY) return input.fixtures();
  if (entered.has(input.execution)) fail(); entered.add(input.execution);
  if (!reviewedChatProfile(input.execution.profile) || input.execution.profile.id !== CHAT_OPENCODE_PROFILE || input.execution.profile.provider !== "opencode"
    || input.execution.profile.model !== CHAT_OPENCODE_MODEL || input.execution.profile.generation !== "native" || input.execution.suite.id !== "chat-features"
    || input.execution.environment.id !== "local" || input.execution.task.flow !== "agent_chat" || input.execution.task.turnTimeoutMs !== 0
    || input.execution.task.id !== "plugins.use-plugin-tool" || input.execution.task.expectedRunCount !== 2 || input.execution.task.attemptTimeoutMs.local !== 480_000) fail();
  const captured = await input.capture(); assertSdkCanaryBuild(captured.build); completeFingerprint(captured.fingerprint);
  if (captured.build.sourceRevision !== input.sourceRevision) fail();
  await input.retain({ schema: "paperclip.sdk-canary-prefixture/v1", executionId: SDK_CANARY, sourceRevision: input.sourceRevision,
    authenticatedMetadataSha256: pins.authenticatedMetadataSha256, build: captured.build, fingerprint: captured.fingerprint });
  fingerprints.set(input.execution, structuredClone(captured.fingerprint));
  return input.fixtures();
}
export async function captureSdkCanaryPreFixture(input: { execution: MatrixExecution; repositoryRoot: string; temporaryRoot: string; sourceRevision: string | null; secrets: readonly string[] }) {
  const build = await captureSdkCanaryBuild(input);
  const descriptor = findChatCatalogCase(input.execution.task.id);
  if (!descriptor || descriptor.expectedHumanMessageCount !== 2 || descriptor.expectedRunCount !== 2 || descriptor.attemptTimeoutMs !== 480_000) fail();
  return { build, fingerprint: chatCatalogCaseFingerprint(descriptor, normalizedChatCatalogExecution(input.execution)) };
}
export function assertSdkCanaryFingerprintMatches(execution: MatrixExecution, fingerprint: Fingerprint) {
  if (execution.id !== SDK_CANARY) return;
  completeFingerprint(fingerprint);
  const before = fingerprints.get(execution);
  if (!before || JSON.stringify(before) !== JSON.stringify(fingerprint)) fail();
}

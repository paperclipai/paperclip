import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import inputs from "./source-sdk-public-inputs.json" with { type: "json" };
import pins from "./sdk-canary-build-pins.json" with { type: "json" };
import type { MatrixExecution } from "./types.js";
const state = vi.hoisted(() => ({ source: null as unknown, retained: null as unknown, refuse: false }));
vi.mock("./source-sdk-public-type.js", () => ({ verifySdkPublicSource: async () => {
  if (state.refuse) throw new Error("Synthetic source/scan prerequisite refused"); return state.source;
} }));
vi.mock("./source-sdk-evidence.js", () => ({ verifyRetainedSourceSdk: async () => state.retained }));
import * as sdk from "./sdk-canary-prefixture.js";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sha = "a".repeat(64), revision = "b".repeat(40);
const selected = () => ({ id: sdk.SDK_CANARY,
  profile: { id: "runner-opencode", provider: "opencode", adapterType: "paperclip_runner", credential: "OPENROUTER_API_KEY", generation: "native", model: "openrouter/deepseek/deepseek-v4.1-flash-1017" },
  suite: { id: "chat-features" }, environment: { id: "local" },
  task: { id: "plugins.use-plugin-tool", flow: "agent_chat", turnTimeoutMs: 0, expectedRunCount: 2, attemptTimeoutMs: { local: 480_000 } } }) as MatrixExecution;
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "sdk-observation-unit-")));
  for (const file of Object.keys(inputs.inputs)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), file.endsWith(".json") ? '{}' : 'synthetic unit input\n');
  }
  await mkdir(path.join(root, "tests/runner-e2e"), { recursive: true });
  await writeFile(path.join(root, "tests/runner-e2e/source-sdk-public-inputs.json"), JSON.stringify(inputs));
  const packages = [["node_modules/typescript/package.json", "typescript", "6.0.3"],
    ["node_modules/.pnpm/@babel+parser@7.29.8/node_modules/@babel/parser/package.json", "@babel/parser", "7.29.8"],
    ["node_modules/zod/package.json", "zod", "4.0.0"]];
  const packageHashes: string[] = [];
  for (const [file, name, version] of packages) {
    await mkdir(path.dirname(path.join(root, file!)), { recursive: true });
    const bytes = JSON.stringify({ name, version }); await writeFile(path.join(root, file!), bytes); packageHashes.push(hash(bytes));
  }
  const files: Array<{ file: string; size: number; sha256: string }> = [], targets = [];
  for (const expected of pins.certificates) {
    await mkdir(path.join(root, expected.target), { recursive: true });
    const marker = { sources: sha, outputs: "c".repeat(64) };
    targets.push({ directory: expected.target, ...marker });
    for (const [file, content] of [["index.js", "synthetic compiled unit fixture only"], [".paperclip-build-complete", JSON.stringify(marker)]]) {
      const relative = `${expected.target}/${file}`; await writeFile(path.join(root, relative), content!);
      files.push({ file: relative, size: Buffer.byteLength(content!), sha256: hash(content!) });
    }
  }
  const identity = { inputs: Object.keys(inputs.inputs).length, manifestSha256: sha, lockSha256: hash(await readFile(path.join(root, "pnpm-lock.yaml"))),
    compilerPackageSha256: packageHashes[0]!, parserPackageSha256: packageHashes[1]!, parserEntrySha256: sha,
    zodPackageSha256: packageHashes[2]!, zodEntrySha256: sha, zodTypeGraphSha256: sha };
  state.source = { identity }; state.refuse = false;
  state.retained = { receipt: { schema: "paperclip.source-plugin-sdk/v2", scanAudit: { bounded: true, suppressedFindings: 0 },
    certifiedTargets: targets, buildHelperSha256: hash(await readFile(path.join(root, "scripts/ensure-plugin-build-deps.mjs"))), lockSha256: identity.lockSha256 }, files };
  return { root, input: { repositoryRoot: root, temporaryRoot: root, sourceRevision: revision, secrets: [] } };
}
it("owning capture retains a closed observation before stale pins refuse every fixture/provider opportunity", async () => {
  const f = await fixture(), records: unknown[] = [], fixtures = vi.fn();
  try {
    await expect(sdk.withSdkCanaryPreFixture({ execution: selected(), sourceRevision: revision,
      capture: async () => ({ build: await sdk.captureSdkCanaryBuild({ ...f.input, retainBuildObservation: async value => { records.push(value); } }), fingerprint: null as never }),
      retain: vi.fn(), fixtures })).rejects.toThrow("SDK canary pre-fixture prerequisite is unqualified");
    expect(records).toHaveLength(1); expect(fixtures).not.toHaveBeenCalled();
    const record = records[0] as ReturnType<typeof sdk.closedSdkCanaryBuildObservation>;
    expect(record.qualification).toBe("UNQUALIFIED_OBSERVATION_ONLY"); expect(record.doesNotRenewExpectedPins).toBe(true);
    expect(record.doesNotAttestFeatureOutcome).toBe(true); expect(record.build.inputFiles).toBe(506);
    expect(record.build.compiledManifestSha256).toBe(record.build.retainedManifestSha256);
    expect(record.toolchain.compiler.version).toBe("6.0.3"); expect(record.toolchain.parser.version).toBe("7.29.8");
    expect(record.toolchain.zod.version).toBe("4.0.0"); expect(Object.isFrozen(record.build)).toBe(true);
    expect(() => sdk.assertSdkCanaryBuild(record.build)).toThrow();
    expect(JSON.stringify(record)).not.toContain(f.root); expect(JSON.stringify(record)).not.toContain("synthetic unit input");
    expect(JSON.stringify(record).length).toBeLessThan(16_384);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it.each(["source-refused", "scan-incomplete", "suppressed", "retained-mismatch", "compiler-metadata", "marker-mismatch", "registered-secret", "retention-failed"])("keeps %s fail-closed and never reaches fixtures", async fault => {
  const f = await fixture(), sink = vi.fn(async () => { if (fault === "retention-failed") throw new Error("Synthetic sink failure"); }), fixtures = vi.fn();
  try {
    if (fault === "source-refused") state.refuse = true;
    if (fault === "scan-incomplete") (state.retained as any).receipt.scanAudit.bounded = false;
    if (fault === "suppressed") (state.retained as any).receipt.scanAudit.suppressedFindings = 1;
    if (fault === "retained-mismatch") (state.retained as any).files[0].sha256 = "f".repeat(64);
    if (fault === "marker-mismatch") (state.retained as any).receipt.certifiedTargets[0].outputs = "f".repeat(64);
    if (fault === "compiler-metadata") await writeFile(path.join(f.root, "node_modules/typescript/package.json"), JSON.stringify({ name: "typescript", version: "secret-value" }));
    await expect(sdk.withSdkCanaryPreFixture({ execution: selected(), sourceRevision: revision,
      capture: async () => ({ build: await sdk.captureSdkCanaryBuild({ ...f.input, secrets: fault === "registered-secret" ? [sha] : [], retainBuildObservation: sink }), fingerprint: null as never }),
      retain: vi.fn(), fixtures })).rejects.toThrow();
    expect(fixtures).not.toHaveBeenCalled();
    if (fault !== "retention-failed") expect(sink).not.toHaveBeenCalled();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it("closed projection refuses unknown fields, unsafe version strings, foreign targets and invalid digests", async () => {
  const f = await fixture(); let saved: ReturnType<typeof sdk.closedSdkCanaryBuildObservation> | undefined;
  try {
    await expect(sdk.captureSdkCanaryBuild({ ...f.input, retainBuildObservation: async value => { saved = value; } })).rejects.toThrow();
    expect(saved).toBeDefined();
    const original = saved!, secret = "SYNTHETIC_PRIVATE_VALUE_MUST_NOT_LEAVE";
    for (const change of [
      (value: any) => { value.build.credentials = secret; },
      (value: any) => { value.toolchain.compiler.version = secret; },
      (value: any) => { value.toolchain.nodeVersion = "1".repeat(10000) + ".0.0"; },
      (value: any) => { value.build.certificates[0].target = secret; },
      (value: any) => { value.build.lockSha256 = secret; },
    ]) {
      const value = structuredClone(original); change(value);
      expect(() => sdk.closedSdkCanaryBuildObservation(value.build, value.toolchain)).toThrow();
    }
    expect(JSON.stringify(original)).not.toContain(secret);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("a shape-valid closed observation never claims pin renewal or a feature pass even for matched synthetic pins", () => {
  const build = { sourceRevision: revision, inputFiles: pins.inputFiles, gitInputFiles: pins.gitInputFiles,
    frozenInputManifestSha256: pins.frozenInputManifestSha256, copiedInputManifestSha256: pins.copiedInputManifestSha256,
    publicInputsFileSha256: pins.publicInputsFileSha256, helperSha256: pins.helperSha256, lockSha256: pins.lockSha256,
    compilerPackageSha256: pins.compilerPackageSha256, compiledFiles: pins.compiledFiles, compiledManifestSha256: pins.compiledManifestSha256,
    retainedManifestSha256: pins.compiledManifestSha256, certificates: structuredClone(pins.certificates) };
  const metadata = { nodeVersion: "24.0.0", inputs: pins.inputFiles, manifestSha256: sha,
    compiler: { version: "6.0.3", packageSha256: pins.compilerPackageSha256 },
    parser: { version: "7.29.8", packageSha256: sha, entrySha256: sha },
    zod: { version: "4.0.0", packageSha256: sha, entrySha256: sha, typeGraphSha256: sha } };
  expect(() => sdk.assertSdkCanaryBuild(build)).not.toThrow();
  const observation = sdk.closedSdkCanaryBuildObservation(build, metadata);
  expect(observation.qualification).toBe("UNQUALIFIED_OBSERVATION_ONLY");
  expect(observation.doesNotRenewExpectedPins).toBe(true); expect(observation.doesNotAttestFeatureOutcome).toBe(true);
});

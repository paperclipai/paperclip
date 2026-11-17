import { expect, it, vi } from "vitest";
import { readFile, writeFile, mkdir, mkdtemp, realpath, symlink, rm } from "node:fs/promises";
import path from "node:path"; import os from "node:os"; import { createHash } from "node:crypto";
import pins from "./sdk-canary-build-pins.json" with { type: "json" };
import { assertSdkCanaryBuild, sdkCanaryOutputManifest, withSdkCanaryPreFixture, assertSdkCanaryFingerprintMatches, SDK_CANARY, type SdkCanaryBuildObservation } from "./sdk-canary-prefixture.js";
import type { MatrixExecution } from "./types.js";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const revision = "a".repeat(40);
const build = (): SdkCanaryBuildObservation => ({ ...pins, sourceRevision: revision, retainedManifestSha256: pins.compiledManifestSha256 });
const execution = () => ({ id: SDK_CANARY, profile: { id: "runner-opencode", provider: "opencode", adapterType: "paperclip_runner", credential: "OPENROUTER_API_KEY", generation: "native", model: "openrouter/deepseek/deepseek-v4.1-flash-1017" }, suite: { id: "chat-features" }, environment: { id: "local" }, task: { id: "plugins.use-plugin-tool", flow: "agent_chat", turnTimeoutMs: 0, expectedRunCount: 2, attemptTimeoutMs: { local: 480_000 } } }) as MatrixExecution;
type Fingerprint = Parameters<typeof assertSdkCanaryFingerprintMatches>[1];
// A synthetic value for lifecycle controls only; never computed or reported as an actual case fingerprint.
const fingerprint = () => ({ fingerprintKind: "complete-execution-and-oracle-closure", digest: "b".repeat(64), definitionDigest: "b".repeat(64), graderDigest: "b".repeat(64), sources: [{ file: "packages/plugins/sdk/dist/index.js", sha256: "c".repeat(64) }] }) as unknown as Fingerprint;
it("binds authenticated output pins to the diagnostic and500Git+lock-overlay contract", () => {
  expect(pins.authenticatedMetadataSha256).toBe("56e130cadb510a7bbbfc9aea2386a655d83ad7a13e84a326e1019ad856f2068c");
  expect(pins.inputFiles).toBe(501); expect(pins.gitInputFiles).toBe(500); expect(pins.compiledFiles).toBe(1611);
  expect(() => assertSdkCanaryBuild(build())).not.toThrow();
});
it.each(["inputFiles", "gitInputFiles", "frozenInputManifestSha256", "copiedInputManifestSha256", "publicInputsFileSha256", "helperSha256", "lockSha256", "compilerPackageSha256", "compiledFiles", "compiledManifestSha256", "retainedManifestSha256", "sourceRevision", "certificates"] as const)("blocks mismatched %s", field => {
  const wrong = build(); Object.assign(wrong, { [field]: typeof wrong[field] === "number" ? 0 : field === "certificates" ? [] : "mismatch" });
  expect(() => assertSdkCanaryBuild(wrong)).toThrow();
});
it("captures and privately retains the non-null complete fingerprint before allowing fixtures once", async () => {
  const order: string[] = [], selected = execution(), fp = fingerprint();
  const run = () => withSdkCanaryPreFixture({ execution: selected, sourceRevision: revision,
    capture: async () => { order.push("capture-after-existing-startup-build-retention"); return { build: build(), fingerprint: fp }; },
    retain: async () => { order.push("private-proof"); }, fixtures: async () => { order.push("fixtures-and-possible-hello"); return 7; } });
  expect(await run()).toBe(7); expect(order).toEqual(["capture-after-existing-startup-build-retention", "private-proof", "fixtures-and-possible-hello"]);
  expect(() => assertSdkCanaryFingerprintMatches(selected, structuredClone(fp))).not.toThrow();
  await expect(run()).rejects.toThrow(); expect(order).toHaveLength(3);
  expect(() => assertSdkCanaryFingerprintMatches(selected, { ...fp, digest: "d".repeat(64) } as never)).toThrow();
});
it.each(["startup-build-or-retention", "missing-output", "missing-fingerprint", "deferred-fingerprint", "private-retention", "wrong-source"])("never admits fixtures when %s fails", async reason => {
  const fixtures = vi.fn(), fp = fingerprint();
  await expect(withSdkCanaryPreFixture({ execution: execution(), sourceRevision: revision,
    capture: async () => {
      if (["startup-build-or-retention", "missing-output"].includes(reason)) throw new Error("Synthetic startup prerequisite failed");
      return { build: { ...build(), ...(reason === "wrong-source" ? { sourceRevision: "e".repeat(40) } : {}) },
        fingerprint: reason === "missing-fingerprint" ? null as never : reason === "deferred-fingerprint" ? { ...fp, digest: null } as never : fp };
    }, retain: async () => { if (reason === "private-retention") throw new Error("Synthetic private custody failure"); }, fixtures })).rejects.toThrow();
  expect(fixtures).not.toHaveBeenCalled();
});
it("rejects a later fingerprint without pre-fixture custody and leaves nonselected cases unchanged", async () => {
  expect(() => assertSdkCanaryFingerprintMatches(execution(), fingerprint())).toThrow();
  const other = { ...execution(), id: "chat-features.runner-opencode.local.plugins.install-plugin" }, capture = vi.fn(), retain = vi.fn(), fixtures = vi.fn(async () => 3);
  expect(await withSdkCanaryPreFixture({ execution: other, sourceRevision: null, capture, retain, fixtures })).toBe(3);
  expect(capture).not.toHaveBeenCalled(); expect(retain).not.toHaveBeenCalled(); expect(fixtures).toHaveBeenCalledOnce();
});
it("reads owned synthetic compiled manifests, detects missing output and rejects symlinks without a compiler", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "sdk-canary-synthetic-")));
  try {
    const rows = [];
    for (const target of pins.certificates) {
      await mkdir(path.join(root, target.target), { recursive: true });
      for (const [file, text] of [["index.js", "export const syntheticUnit=true;\n"], [".paperclip-build-complete", JSON.stringify({ sources: "a".repeat(64), outputs: "b".repeat(64) })+'\n']]) {
        await writeFile(path.join(root, target.target, file!), text!);
        rows.push({ file: `${target.target}/${file}`, size: Buffer.byteLength(text!), sha256: hash(text!) });
      }
    }
    rows.sort((a, b) => a.file.localeCompare(b.file));
    expect(await sdkCanaryOutputManifest(root)).toEqual(rows);
    const synthetic = { ...build(), compiledFiles: rows.length, compiledManifestSha256: hash(JSON.stringify(rows)), retainedManifestSha256: hash(JSON.stringify(rows)) };
    expect(() => assertSdkCanaryBuild(synthetic, { ...pins, compiledFiles: rows.length, compiledManifestSha256: synthetic.compiledManifestSha256 })).not.toThrow();
    expect(() => assertSdkCanaryBuild(synthetic)).toThrow(); // Live immutable1611-file expectations never accept toy outputs.
    await writeFile(path.join(root, pins.certificates[0]!.target, "index.js"), "synthetic mutation");
    expect(hash(JSON.stringify(await sdkCanaryOutputManifest(root)))).not.toBe(synthetic.compiledManifestSha256);
    await rm(path.join(root, pins.certificates[0]!.target), { recursive: true }); await expect(sdkCanaryOutputManifest(root)).rejects.toThrow();
    await symlink(path.join(root, pins.certificates[1]!.target), path.join(root, pins.certificates[0]!.target)); await expect(sdkCanaryOutputManifest(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["model", "credential", "generation", "suite", "environment", "flow", "turn-clock", "count", "overall-clock"])("rejects changed selected %s before capture or fixtures", async field => {
  const selected = execution(), capture = vi.fn(), fixtures = vi.fn();
  if (field === "model") selected.profile.model = "foreign/model";
  if (field === "credential") selected.profile.credential = "OPENAI_API_KEY";
  if (field === "generation") selected.profile.generation = "legacy";
  if (field === "suite") selected.suite.id = "another-suite";
  if (field === "environment") selected.environment.id = "daytona";
  if (field === "flow") selected.task.flow = "first_task";
  if (field === "turn-clock") selected.task.turnTimeoutMs = 120000;
  if (field === "count") selected.task.expectedRunCount = 3;
  if (field === "overall-clock") selected.task.attemptTimeoutMs = { ...selected.task.attemptTimeoutMs, local: 960000 };
  await expect(withSdkCanaryPreFixture({ execution: selected, sourceRevision: revision, capture, retain: vi.fn(), fixtures })).rejects.toThrow();
  expect(capture).not.toHaveBeenCalled(); expect(fixtures).not.toHaveBeenCalled();
});

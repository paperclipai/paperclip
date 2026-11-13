import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gradeRepositoryProof, repositoryConfigurationDigest, repositoryProofTasks, type RepositoryProofObservation } from "./repository-verification.js";
import { runnerSuites } from "./catalog.js";

function valid(): RepositoryProofObservation {
  const sourceBytes = `${"a7".repeat(32)}\n`, commit = "b".repeat(40);
  return { conversion: true, originalAdapter: "codex_local", expectedLegacyAdapter: "codex_local", finalAdapter: "paperclip_runner",
    configurationBefore: "config", configurationAfter: "config", instructionsBefore: "instructions", instructionsAfter: "instructions",
    permissionsPreserved: true, expectedModel: "gpt-6.1-sol", actualModel: "gpt-6.1-sol", expectedProvider: "codex", actualProvider: "codex",
    environmentRetained: true, issueDone: true, runCount: 1, committedRuns: 1, sourceBytes, currentSourceBytes: sourceBytes,
    expectedCommit: commit, downloaded: { reference: sourceBytes.trimEnd(), sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"), commit },
    downloadVerified: true, visibleDelivery: true, pendingInteractions: 0 };
}
const passes = (value: RepositoryProofObservation) => gradeRepositoryProof(value).every(check => check.passed);

describe("configured repository and conversion qualification", () => {
  it("accepts independently verified actual conversion and ordinary delivery", () => {
    expect(passes(valid())).toBe(true);
    expect(passes({ ...valid(), conversion: false, originalAdapter: "paperclip_runner" })).toBe(true);
  });
  it.each([
    { originalAdapter: "paperclip_runner" }, { finalAdapter: "codex_local" },
    { configurationAfter: "changed environment reference" }, { instructionsAfter: "lost instructions" },
    { permissionsPreserved: false }, { environmentRetained: false }, { actualModel: "gpt-5.6-sol" },
    { actualProvider: "acpx:claude" }, { runCount: 2 }, { committedRuns: 0 }, { issueDone: false },
    { currentSourceBytes: null }, { currentSourceBytes: "recreated" }, { expectedCommit: "" },
    { downloadVerified: false }, { visibleDelivery: false }, { pendingInteractions: 1 },
  ])("rejects missing or contrary evidence %j", change => expect(passes({ ...valid(), ...change })).toBe(false));
  it.each([
    null, "a badge is green", [], {}, { reference: "wrong", sourceSha256: "wrong", commit: "wrong" },
  ])("does not accept provider success or malformed downloaded output %j", downloaded => expect(passes({ ...valid(), downloaded })).toBe(false));
  it("rejects each incorrect result field and extra fields", () => {
    const baseline = valid(), result = baseline.downloaded as Record<string, unknown>;
    for (const field of ["reference", "sourceSha256", "commit"]) expect(passes({ ...baseline, downloaded: { ...result, [field]: "wrong" } })).toBe(false);
    expect(passes({ ...baseline, downloaded: { ...result, success: true } })).toBe(false);
  });
  it("hashes retained configuration consistently without returning its contents", () => {
    const before = { defaultEnvironmentId: "env", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      adapterConfig: { model: "model", cwd: "/owned", env: { KEY: { type: "secret_ref", secretId: "sensitive-fixture-reference", version: 1 } }, timeoutSec: 240 } };
    const reordered = { ...before, adapterConfig: { ...before.adapterConfig, env: { KEY: { version: 1, secretId: "sensitive-fixture-reference", type: "secret_ref" } } } };
    expect(repositoryConfigurationDigest(before)).toBe(repositoryConfigurationDigest(reordered));
    expect(repositoryConfigurationDigest(before)).toMatch(/^[a-f0-9]{64}$/);
    expect(repositoryConfigurationDigest(before)).not.toContain("sensitive-fixture-reference");
    expect(repositoryConfigurationDigest({ ...before, defaultEnvironmentId: "other" })).not.toBe(repositoryConfigurationDigest(before));
    expect(repositoryConfigurationDigest({ ...before, adapterConfig: { ...before.adapterConfig, env: {} } })).not.toBe(repositoryConfigurationDigest(before));
  });
  it("registers explicit development cells with staging models and production instructions", () => {
    for (const id of ["configured-repository", "legacy-conversion", "automatic-repository-configured-models"]) {
      const suite = runnerSuites.find(suite => suite.id === id)!;
      expect(suite.manualOnly).toBe(true);
      expect(suite.groups).toEqual([]);
      expect(suite.expectedMatrixSize).toBe(4);
      expect(suite.profiles.map(profile => profile.model)).toEqual(["gpt-6.1-sol", "claude-opus-5-5"]);
      expect(suite.definitionMetadata?.stagingQualification).toBe(false);
      expect(suite.tasks).toHaveLength(1);
      expect(suite.tasks[0]?.flow).toBe(id === "automatic-repository-configured-models" ? "automatic_repository" : "repository_verification");
      expect(suite.tasks[0]?.automaticRetryPolicy).toBe("single_attempt");
    }
    expect(repositoryProofTasks.every(task => task.expectedRunCount === 1)).toBe(true);
  });
});

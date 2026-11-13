import { describe, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { FINALIZATION_PAYLOAD_BYTES, finalizationResultDigest, parseFinalizationProof, gradeFinalizationRecovery, type FinalizationRecoveryObservation } from "./finalization-recovery.js";

function fixture(): FinalizationRecoveryObservation {
  const binding = { companyId: "company", issueId: "task", runId: "run" }, observedAt = "2026-10-21T12:00:00.000Z";
  return { binding,
    before: { resultDigest: "a".repeat(64), acceptedResults: 1, providerTurns: 1, operationIds: ["unfinished"], artifactId: "original", artifactSha256: "b".repeat(64) },
    crash: { ...binding, nativePhase: "workspace_finalizing", observedAt },
    final: { runIds: ["run"], committed: true, issueDone: true, resultDigest: "a".repeat(64), acceptedResults: 1, providerTurns: 1,
      resumedOperations: [{ resumedFromOperationId: "unfinished", startedAt: "2026-10-21T12:00:01.000Z" }], artifactId: "original", artifactSha256: "b".repeat(64),
      byteSize: FINALIZATION_PAYLOAD_BYTES, actualSha256: "c".repeat(64), expectedSha256: "c".repeat(64), proofReference: "d".repeat(64),
      finalDeliveryCount: 1, deliveryReceiptMatches: true, visibleDelivery: true, pendingInteractions: 0 } };
}
const passes = (value: FinalizationRecoveryObservation) => gradeFinalizationRecovery(value).every(check => check.passed);

describe("finalization restart without provider replay", () => {
  it("accepts only the unchanged result and artifact with real interrupted-operation recovery", () => expect(passes(fixture())).toBe(true));
  it.each([
    ["no saved result", (v: FinalizationRecoveryObservation) => { v.before = null; }],
    ["no crash receipt", (v: FinalizationRecoveryObservation) => { v.crash = null; }],
    ["foreign crash company", (v: FinalizationRecoveryObservation) => { v.crash!.companyId = "foreign"; }],
    ["foreign crash task", (v: FinalizationRecoveryObservation) => { v.crash!.issueId = "foreign"; }],
    ["foreign crash run", (v: FinalizationRecoveryObservation) => { v.crash!.runId = "foreign"; }],
    ["crash during provider work", (v: FinalizationRecoveryObservation) => { v.crash!.nativePhase = "running"; }],
    ["missing operation boundary", (v: FinalizationRecoveryObservation) => { v.before!.operationIds = []; }],
    ["completed before crash", (v: FinalizationRecoveryObservation) => { v.final!.resumedOperations = []; }],
    ["unrelated recovered operation", (v: FinalizationRecoveryObservation) => { v.final!.resumedOperations[0]!.resumedFromOperationId = "foreign"; }],
    ["recovery predates crash", (v: FinalizationRecoveryObservation) => { v.final!.resumedOperations[0]!.startedAt = "2026-10-21T11:00:00.000Z"; }],
    ["invalid crash clock", (v: FinalizationRecoveryObservation) => { v.crash!.observedAt = "unknown"; }],
    ["uncommitted result", (v: FinalizationRecoveryObservation) => { v.final!.committed = false; }],
    ["unfinished task", (v: FinalizationRecoveryObservation) => { v.final!.issueDone = false; }],
    ["new run", (v: FinalizationRecoveryObservation) => { v.final!.runIds.push("retry"); }],
    ["substituted run", (v: FinalizationRecoveryObservation) => { v.final!.runIds = ["retry"]; }],
    ["changed saved result", (v: FinalizationRecoveryObservation) => { v.final!.resultDigest = "e".repeat(64); }],
    ["provider turn replay", (v: FinalizationRecoveryObservation) => { v.final!.providerTurns++; }],
    ["result accepted again", (v: FinalizationRecoveryObservation) => { v.final!.acceptedResults++; }],
    ["substituted artifact", (v: FinalizationRecoveryObservation) => { v.final!.artifactId = "new"; }],
    ["changed artifact bytes", (v: FinalizationRecoveryObservation) => { v.final!.artifactSha256 = "e".repeat(64); }],
    ["incomplete workspace copy", (v: FinalizationRecoveryObservation) => { v.final!.byteSize--; }],
    ["changed workspace bytes", (v: FinalizationRecoveryObservation) => { v.final!.actualSha256 = "e".repeat(64); }],
    ["missing original reference", (v: FinalizationRecoveryObservation) => { v.final!.proofReference = ""; }],
    ["duplicate final reply", (v: FinalizationRecoveryObservation) => { v.final!.finalDeliveryCount = 2; }],
    ["wrong delivery receipt", (v: FinalizationRecoveryObservation) => { v.final!.deliveryReceiptMatches = false; }],
    ["hidden result", (v: FinalizationRecoveryObservation) => { v.final!.visibleDelivery = false; }],
    ["unanswered interaction", (v: FinalizationRecoveryObservation) => { v.final!.pendingInteractions = 1; }],
  ] as const)("rejects %s", (_name, change) => { const value = fixture(); change(value); expect(passes(value)).toBe(false); });
  it("hashes JSON results independent of object-key order without normalizing changed content", () => {
    expect(finalizationResultDigest({ summary: "ready", continuation: { kind: "same_agent", key: "one" } }))
      .toBe(finalizationResultDigest({ continuation: { key: "one", kind: "same_agent" }, summary: "ready" }));
    expect(finalizationResultDigest({ summary: "ready" })).not.toBe(finalizationResultDigest({ summary: "changed" }));
  });
  it("retains only the exact bounded synthetic proof and excludes unexpected fields from diagnostics", () => {
    const proof = { reference: "a".repeat(64), byteSize: FINALIZATION_PAYLOAD_BYTES, sha256: "b".repeat(64) };
    expect(parseFinalizationProof(proof)).toEqual(proof);
    for (const value of [null, [], {}, { ...proof, byteSize: 1 }, { ...proof, reference: "unknown" }, { ...proof, sha256: "unknown" },
      { ...proof, "sensitive-field-name": "sensitive-field-value" }]) {
      expect(() => parseFinalizationProof(value)).toThrow("Original proof does not match the requested file contract");
      try { parseFinalizationProof(value); } catch (error) { expect(String(error)).not.toContain("sensitive-field"); }
    }
  });
  it("registers only two explicit remote development cells and requires a real fault", () => {
    const cells = runnerMatrix.filter(cell => cell.suite.id === "finalization-recovery");
    expect(cells).toHaveLength(2);
    expect(new Set(cells.map(cell => cell.profile.model))).toEqual(new Set(["gpt-6.1-sol", "claude-opus-5-5"]));
    expect(cells.every(cell => cell.environment.id === "daytona" && cell.suite.manualOnly && cell.suite.groups.length === 0 &&
      cell.suite.definitionMetadata?.stagingQualification === false && cell.suite.definitionMetadata?.unexercisedFaultIsFailure === true &&
      cell.task.automaticRetryPolicy === "single_attempt")).toBe(true);
  });
});

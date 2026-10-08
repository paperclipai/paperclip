import { describe, expect, it } from "vitest";
import { retainedMainlineStop } from "./copilot-stop-test-fixtures.js";
import { assertCopilotStopAcknowledgement, readCopilotStopAcknowledgement } from "./copilot-stop-acknowledgement.js";

const fixtureCorrelationId = "db8b16c1-aafa-4662-9cf4-0bb317db7751";
function fixture() {
  const run = structuredClone(retainedMainlineStop.run);
  const scope = { companyId: run.companyId, runId: run.id, issueId: run.nativeIssueId, callerUserId: "local-board" };
  const read = () => readCopilotStopAcknowledgement(run, scope, fixtureCorrelationId, "100", "101");
  return { run, scope, read };
}
describe("current-mainline Copilot Stop API acknowledgement", () => {
  it("calibrates against the retained failed attempt without requiring an unsupported caller-owned intent", () => {
    const f = fixture(), proof = f.read();
    expect(proof.intentId).not.toBe(`native-cancellation:${fixtureCorrelationId}`);
    expect(proof).toMatchObject({ fixtureCorrelationId, intentId: "native-cancellation:88c9dd8f-92d2-407d-a989-a3495e8e6944" });
    expect(() => assertCopilotStopAcknowledgement(proof, f.run, f.scope, fixtureCorrelationId, "100")).not.toThrow();
    expect(retainedMainlineStop.outcome).toContain("calibration only");
  });
  it.each([
    ["foreign run", (r: any) => { r.id = "foreign"; }],
    ["foreign company", (r: any) => { r.companyId = "foreign"; }],
    ["foreign issue", (r: any) => { r.nativeIssueId = "foreign"; }],
    ["failed run", (r: any) => { r.status = "failed"; }],
    ["non-native run", (r: any) => { r.runtimeMode = "legacy"; }],
    ["foreign API caller", (r: any) => { r.resultJson.cancelledByUserId = "other"; }],
    ["agent caller", (r: any) => { r.resultJson.cancelledByActorType = "agent"; }],
    ["foreign initiator", (r: any) => { r.resultJson.cancellation.initiator.id = "other"; }],
    ["provider cancellation", (r: any) => { r.resultJson.cancellation.source = "provider"; }],
    ["unexpected cancellation", (r: any) => { r.resultJson.cancellation.expected = false; }],
    ["missing timestamp", (r: any) => { delete r.resultJson.startupCancellation.requestedAt; }],
    ["startup-only cancellation", (r: any) => { r.resultJson.startupCancellation.beforeNativeSelection = true; }],
    ["foreign acknowledgement", (r: any) => { r.resultJson.nativeCancellation.runId = "foreign"; }],
    ["unacknowledged intent", (r: any) => { r.resultJson.nativeCancellation.dispatchState = "pending"; }],
    ["undispatched intent", (r: any) => { r.resultJson.nativeCancellation.dispatched = false; }],
    ["missing audit", (r: any) => { delete r.resultJson.nativeCancellation.intentAuditId; }],
    ["same audit", (r: any) => { r.resultJson.nativeCancellation.intentAuditId = r.resultJson.nativeCancellation.acknowledgementAuditId; }],
    ["unexpected effects", (r: any) => { r.resultJson.nativeCancellation.effects.push("replay"); }],
    ["invalid intent", (r: any) => { r.resultJson.nativeCancellation.intentId = "native-cancellation:foreign"; }],
  ] as const)("rejects %s", (_label, mutate) => { const f = fixture(); mutate(f.run); expect(f.read).toThrow(/acknowledgement/); });
  it.each(["100", "99", "0", "bad", "1".repeat(31)])("rejects response clock %s", clock => {
    const f = fixture(); expect(() => readCopilotStopAcknowledgement(f.run, f.scope, fixtureCorrelationId, "100", clock)).toThrow(/acknowledgement/);
  });
  it("requires retention of the actual response and rejects later replacement metadata", () => {
    const f = fixture(), proof = f.read();
    expect(() => assertCopilotStopAcknowledgement(undefined as any, f.run, f.scope, fixtureCorrelationId, "100")).toThrow(/not retained/);
    f.run.resultJson.nativeCancellation.intentId = "native-cancellation:11111111-2222-4333-8444-555555555555";
    expect(() => assertCopilotStopAcknowledgement(proof, f.run, f.scope, fixtureCorrelationId, "100")).toThrow(/changed/);
  });
  it("rejects a replayed API response from another fixture dispatch", () => {
    const f = fixture(), proof = f.read();
    expect(() => assertCopilotStopAcknowledgement(proof, f.run, f.scope, "11111111-2222-4333-8444-555555555555", "100")).toThrow(/changed/);
    expect(() => assertCopilotStopAcknowledgement(proof, f.run, f.scope, fixtureCorrelationId, "99")).toThrow(/changed/);
  });
});

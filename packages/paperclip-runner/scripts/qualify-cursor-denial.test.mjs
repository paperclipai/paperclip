import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { evaluateDenial, isProbeWrite, permissionResponse } from "./qualify-cursor-denial.mjs";

const message = { id: 0, params: { sessionId: "active", options: [
  { kind: "allow_once", optionId: "native-allow" }, { kind: "reject_once", optionId: "native-deny-17" },
] } };
test("denial preserves numeric zero request IDs and actual offered option identity", () => {
  assert.deepEqual(permissionResponse(message, "active").response, {
    jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "selected", optionId: "native-deny-17" } },
  });
});
test("stale sessions and ambiguous or missing rejection choices are cancelled", () => {
  for (const candidate of [
    { message, session: undefined }, { message, session: "different" },
    { message: { ...message, params: { ...message.params, options: [] } }, session: "active" },
    { message: { ...message, params: { ...message.params, options: [...message.params.options, { kind: "reject_once", optionId: "another" }] } }, session: "active" },
    { message: { ...message, params: { ...message.params, options: [...message.params.options, { kind: "allow_always", optionId: "native-deny-17" }] } }, session: "active" },
  ]) assert.deepEqual(permissionResponse(candidate.message, candidate.session).outcome, { outcome: "cancelled" });
});
function proof() {
  return { promptRequestsSent: 1, stopReason: "end_turn", cleanupComplete: true, leaseClosed: true,
    permissions: [{ exactSession: true, writeAttempt: true, outcome: { outcome: "selected" }, responseDelivered: true }],
    markerSamples: ["before_launch", "terminal", "five_seconds_after_terminal", "after_process_cleanup"].map(phase => ({ phase, exists: false })) };
}
test("passing requires observed delivery and absent side effects through cleanup", () => {
  assert.equal(evaluateDenial(proof()).passed, true);
  const noRequest = proof(); noRequest.permissions = [];
  assert.ok(evaluateDenial(noRequest).failures.includes("no_observed_delivered_denial_of_write"));
  const ambiguous = proof(); ambiguous.permissions[0].responseDelivered = false;
  assert.equal(evaluateDenial(ambiguous).passed, false);
  const sideEffect = proof(); sideEffect.markerSamples.push({ phase: "during_turn", exists: true });
  assert.ok(evaluateDenial(sideEffect).failures.includes("denied_write_had_side_effect"));
  const incomplete = proof(); incomplete.markerSamples.pop(); incomplete.cleanupComplete = false;
  assert.equal(evaluateDenial(incomplete).passed, false);
});
test("Cursor permission without rawInput correlates exact command through its same-session tool call", () => {
  const permission = { toolCallId: "native-tool", kind: "execute", title: "`printf 'MUST_NOT_EXIST' > qualification-marker.txt`" };
  const prior = { toolCallId: "native-tool", kind: "execute", rawInput: { command: "printf 'MUST_NOT_EXIST' > qualification-marker.txt" } };
  assert.equal(isProbeWrite(permission, prior), true);
  assert.equal(isProbeWrite(permission, undefined), false);
  assert.equal(isProbeWrite(permission, { ...prior, toolCallId: "foreign-tool" }), false);
  assert.equal(isProbeWrite(permission, { ...prior, rawInput: { command: "cat qualification-marker.txt" } }), false);
  assert.equal(isProbeWrite({ ...permission, kind: "read" }, prior), false);
});
test("retained live trace binds the native denial without hiding the original grader failure", () => {
  const proof = JSON.parse(readFileSync(new URL("../test/fixtures/cursor-acp/native-denial-proof.json", import.meta.url), "utf8"));
  const [prior, permission, response] = proof.trace.map(frame => frame.message);
  assert.equal(proof.originalOracleResult.passed, false);
  assert.equal(proof.offlineOracleResult.passed, true);
  assert.equal(proof.assessmentPrompts, 0);
  assert.equal(permission.id, 0);
  assert.equal(permission.params.sessionId, prior.params.sessionId);
  assert.equal(isProbeWrite(permission.params.toolCall, prior.params.update), true);
  assert.deepEqual(response, permissionResponse(permission, prior.params.sessionId).response);
  assert.equal(response.result.outcome.optionId, "reject-once");
  assert.equal(proof.markerSamples.length, 98);
  assert.ok(proof.markerSamples.every(sample => sample.exists === false));
  assert.equal(proof.cleanupComplete, true);
  assert.equal(proof.leaseClosed, true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { qualificationReport, qualificationCadence } from "./muse-qualification-report.mjs";
const HOUR = 3_600_000, start = Date.UTC(2099, 0, 1), expiry = start + 24 * HOUR;
const iso = ms => new Date(ms).toISOString();
function evidence() {
  const samples = Array.from({ length: 24 }, (_, slot) => slot).filter(slot => slot < 6 || slot >= 9).map(slot => {
    const queued = start + slot * HOUR;
    return { slot, queuedAt: iso(queued), offeredAt: iso(queued + 100), claimedAt: iso(queued + 2000),
      nativeAcceptedAt: iso(queued + 2100), acceptedResultAt: iso(queued + 9000), finalizedAt: iso(queued + 10000),
      nativeSucceeded: true, unattended: true, attempts: 1, documentSha256: "b".repeat(64) };
  });
  return { qualification: { startedAt: iso(start), expiresAt: iso(expiry), deadlineEnforcedAt: iso(expiry + 1000), requestedPollIntervalMs: 5000 },
    provenance: { coreRevision: "a".repeat(40), runnerRevision: "b".repeat(40), protocolVersion: 1, mode: "live", profile: "muse-personal", environment: "local" },
    samples, cadence: { from: iso(start), to: iso(expiry), observedIntervals: 17279, withinSevenSeconds: 17000, missingIntervals: 0, maxUnobservedGapMs: 0, complete: true },
    idleWindows: [{ from: iso(start + 6 * HOUR), to: iso(start + 9 * HOUR), coverageComplete: true, healthy: true, activeAssignments: 0, unconsumedInputs: 0 }],
    cleanup: { authorityRevoked: true, workerStopUnconfirmed: false, nativeEffectsUnknown: false }, interventions: [],
    workflows: Object.fromEntries(["researchDocument", "clarification", "followUp", "freshConversationProactive"].map(key => [key, { verified: true }])) };
}
test("complete live evidence reports claim and full-response latency separately", () => {
  const result = qualificationReport(evidence(), expiry + 2000);
  assert.equal(result.qualificationPassed, true); assert.equal(result.releaseQualified, true);
  assert.equal(result.successfulNativeTasks, 21); assert.equal(result.queueToClaim.p95Ms, 2000);
  assert.equal(result.fullResponse.p95Ms, 10000); assert.equal(result.cost, null);
});
test("synthetic evidence and old sixty-second cadence cannot qualify", () => {
  for (const change of [e => e.provenance.mode = "synthetic", e => e.qualification.requestedPollIntervalMs = 60000,
    e => { e.cadence.observedIntervals = 1440; e.cadence.withinSevenSeconds = 0; }]) {
    const e = evidence(); change(e); assert.equal(qualificationReport(e, expiry + 2000).qualificationPassed, false);
  }
});
test("missing cadence tails, idle gaps, claims, native completion and cleanup each fail closed", () => {
  const changes = [e => e.cadence.complete = false, e => e.cadence.missingIntervals = 1,
    e => e.cadence.to = iso(expiry - HOUR), e => e.cadence.maxUnobservedGapMs = 61000,
    e => e.idleWindows[0].coverageComplete = false, e => e.idleWindows[0].activeAssignments = 1,
    e => delete e.samples[0].claimedAt, e => e.samples[0].nativeSucceeded = false,
    e => e.samples[0].unattended = false, e => e.samples[0].attempts = 2,
    e => e.samples[0].slot = e.samples[1].slot, e => e.samples[0].acceptedResultAt = iso(expiry + 1),
    e => e.samples[0].finalizedAt = iso(start + 7 * HOUR), e => e.cleanup.workerStopUnconfirmed = true,
    e => e.cleanup.nativeEffectsUnknown = true, e => e.qualification.deadlineEnforcedAt = iso(expiry + HOUR),
    e => e.interventions.push({ kind: "manual_chat" }), e => e.provenance.runnerRevision = "unknown"];
  for (const change of changes) { const e = evidence(); change(e); assert.equal(qualificationReport(e, expiry + 2000).qualificationPassed, false, String(change)); }
  assert.equal(qualificationReport(evidence(), start + HOUR).qualificationPassed, false);
});
test("successful soak alone does not imply product journey qualification", () => {
  const e = evidence(); e.workflows.clarification.verified = false;
  const result = qualificationReport(e, expiry + 2000);
  assert.equal(result.qualificationPassed, true); assert.equal(result.releaseQualified, false);
});
test("public projection does not copy credentials, private text or identity fields", () => {
  const e = evidence(); e.accessToken = "private-secret"; e.samples[0].issueId = "private-task";
  e.provenance.privateConversation = "private-conversation";
  const output = JSON.stringify(qualificationReport(e, expiry + 2000));
  for (const secret of ["private-secret", "private-task", "private-conversation"]) assert.equal(output.includes(secret), false);
});

test("cadence merges replica timestamps and exposes missing persisted contacts", () => {
  const input = { startedAt: iso(start), expiresAt: iso(start + 20000), cadenceEvidenceComplete: true,
    contacts: [
      { contacts: 3, timestamps: [iso(start), iso(start + 10000), iso(start + 20000)], incomplete: false },
      { contacts: 2, timestamps: [iso(start + 5000), iso(start + 15000)], incomplete: false },
    ] };
  assert.deepEqual(qualificationCadence(input), { from: iso(start), to: iso(start + 20000), observedIntervals: 4,
    withinSevenSeconds: 4, missingIntervals: 0, maxUnobservedGapMs: 0, complete: true });
  input.contacts[1].contacts = 3;
  assert.equal(qualificationCadence(input).complete, false);
  assert.equal(qualificationCadence(input).missingIntervals, 1);
  input.contacts[1].contacts = 2; input.cadenceEvidenceComplete = false;
  assert.equal(qualificationCadence(input).complete, false);
});

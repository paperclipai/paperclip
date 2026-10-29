import { expect, it } from "vitest";
import { antigravityEvidenceFixture, antigravityTurnFixture } from "./antigravity-journey-test-fixtures.js";
import { gradeAntigravityJourney, gradeAntigravityJourneyTurn, sameAntigravityConversation, validateAntigravityJourneyEvidence } from "./antigravity-journey-evidence.js";

it("accepts real-bound exact file evidence despite an unrelated genuine finish rejection", () => {
  const proof = gradeAntigravityJourneyTurn(antigravityTurnFixture());
  expect(proof.toolLifecycle).toEqual({ completedFileOperations: 2, failedFileOperations: 0, failedFinishOperations: 1 });
  const evidence = antigravityEvidenceFixture();
  expect(() => validateAntigravityJourneyEvidence(evidence)).not.toThrow();
  expect(gradeAntigravityJourney(evidence).every(check => check.passed)).toBe(true);
});

const changes: Array<[string, (f: ReturnType<typeof antigravityTurnFixture>) => void]> = [
  ["different task", f => { f.attachment.issueId = "another-task"; }],
  ["different assignee", f => { f.issue.assigneeAgentId = "other-agent"; }],
  ["stale previous run", f => { f.afterRunIds.push(f.run.id); }],
  ["copied attachment", f => { f.attachment.originatingRunId = "old-run"; }],
  ["missing file", f => { f.downloadedBytes = Buffer.alloc(0); }],
  ["wrong actual bytes", f => { f.downloadedBytes[0] = 0; }],
  ["success claim without delivery", f => { f.run.resultJson.semanticToolReceipts = {}; }],
  ["narrative Done without committed result", f => { f.run.resultJson.finalizationPhase = "prepared"; }],
  ["different selected connection", f => { f.run.contextSnapshot.aiConnection.connectionId = "ambient-connection"; }],
  ["different effective model", f => { f.run.runnerProfileJson.sessionCheckpoint.providerIdentity.effectiveModel = "automatic"; }],
  ["old candidate profile", f => { f.expectedProfileDigest = `sha256:${"c".repeat(64)}`; }],
  ["foreign native evidence", f => { f.events[0]!.payload.prpEvent.sourceInstanceId = "other-runner"; }],
  ["failed file read", f => { f.events[3]!.payload.prpEvent.payload.status = "failed"; }],
  ["terminal task with active lease", f => { f.lease.status = "active"; }],
  ["unobserved physical owner", f => { f.retirement.captured = false; }],
  ["remaining native process", f => { f.retirement.remainingProcessCount = 1; }],
  ["PID reused", f => { f.retirement.identityChanged = true; }],
  ["native child still owns lifetime fence", f => { f.retirement.nativeFencesReacquired = false; }],
];
it.each(changes)("rejects %s rather than trusting Done prose", (_label, change) => {
  const fixture = antigravityTurnFixture(); change(fixture);
  expect(() => gradeAntigravityJourneyTurn(fixture)).toThrow("antigravity_evidence_");
});

it.each(["acpxRecordId", "agentSessionId", "backendSessionId", "normalizedSessionId", "workspaceDigest", "profileDigest", "effectiveModel"] as const)("rejects replaced native conversation %s", key => {
  const e = antigravityEvidenceFixture(); e.turnEvidence[1]!.conversation[key] = "replaced";
  expect(sameAntigravityConversation(e.turnEvidence[0]!, e.turnEvidence[1]!)).toBe(false);
});

it("retains first completion as a snapshot when later task reopening changes coordinator pointers", () => {
  const first = antigravityTurnFixture(), observed = gradeAntigravityJourneyTurn(first);
  first.run.resultJson.authoritativeDecision = "in_progress";
  first.run.resultJson.assessmentId = "superseding-assessment";
  expect(observed.finalization.decision).toBe("done");
  expect(observed.finalization.assessmentId).toBe("assessment-run-first");
  expect(() => gradeAntigravityJourneyTurn(first)).toThrow("committed_done");
});

it("rejects an arbitrary retained native payload and altered download bytes", () => {
  const e = antigravityEvidenceFixture();
  (e.turnEvidence[0]!.conversation as any).rawNativePrompt = "private";
  expect(() => validateAntigravityJourneyEvidence(e)).toThrow("retained_shape");
  delete (e.turnEvidence[0]!.conversation as any).rawNativePrompt;
  e.turnEvidence[0]!.artifact.base64 = Buffer.from("not the proof").toString("base64");
  expect(() => validateAntigravityJourneyEvidence(e)).toThrow("retained_artifact");
});

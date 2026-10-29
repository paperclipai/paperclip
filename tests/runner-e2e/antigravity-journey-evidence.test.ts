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

it("accepts Rust allocator and executor-hashed event IDs with independent source sequences", () => {
  const fixture = antigravityTurnFixture();
  const first = fixture.events[0]!;
  first.sourceEventId = first.payload.prpEvent.sourceEventId = `event_${fixture.run.runnerInstanceId}_0000000000000001`;
  expect(fixture.events[1]!.sourceEventId).toMatch(/^event_executor_[a-f0-9]{64}$/u);
  let controlSeq = 0;
  for (const row of fixture.events.filter(row => row.payload.prpEvent.sourceKind === "control_plane")) {
    row.sourceSeq = row.payload.prpEvent.sourceSeq = ++controlSeq;
  }
  expect(() => gradeAntigravityJourneyTurn(fixture)).not.toThrow();
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
  ["missing event ID", f => { delete (f.events[0] as any).sourceEventId; delete (f.events[0]!.payload.prpEvent as any).sourceEventId; }],
  ["empty event ID", f => { f.events[0]!.sourceEventId = f.events[0]!.payload.prpEvent.sourceEventId = ""; }],
  ["oversized event ID", f => { f.events[0]!.sourceEventId = f.events[0]!.payload.prpEvent.sourceEventId = "x".repeat(161); }],
  ["unsafe event ID", f => { f.events[0]!.sourceEventId = f.events[0]!.payload.prpEvent.sourceEventId = "event\nforeign"; }],
  ["duplicate event ID", f => { f.events[1]!.sourceEventId = f.events[1]!.payload.prpEvent.sourceEventId = f.events[0]!.sourceEventId; }],
  ["foreign envelope event ID", f => { f.events[0]!.payload.prpEvent.sourceEventId = "event_from_another_row"; }],
  ["foreign row event ID", f => { f.events[0]!.sourceEventId = "event_from_another_row"; }],
  ["foreign paired source", f => { f.events[0]!.sourceInstanceId = f.events[0]!.payload.prpEvent.sourceInstanceId = "foreign-runner"; }],
  ["replayed source sequence", f => { f.events[1]!.sourceSeq = f.events[1]!.payload.prpEvent.sourceSeq = f.events[0]!.sourceSeq; }],
  ["reordered control source sequence", f => { f.events.at(-1)!.sourceSeq = f.events.at(-1)!.payload.prpEvent.sourceSeq = 1; }],
  ["missing source sequence", f => { delete (f.events[0] as any).sourceSeq; delete (f.events[0]!.payload.prpEvent as any).sourceSeq; }],
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

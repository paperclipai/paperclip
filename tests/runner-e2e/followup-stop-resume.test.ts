import { describe, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { stopRunBelongsToTask, isActiveStopCheckpointRun, exactSyntheticJson, gradeFollowupStopResume, type FollowupStopObservation } from "./followup-stop-resume.js";

function fixture(): FollowupStopObservation {
  return { binding: { companyId: "company", issueId: "task", agentId: "agent" },
    initial: { runId: "original", workspaceId: "workspace", instructionsDigest: "a".repeat(64), toolFingerprint: `sha256:${"b".repeat(64)}`, checkpointVerified: true },
    followup: { commentIds: ["followup"], runId: "original", runStatus: "running", acceptedResults: 0, providerStarted: true, observedAt: "2026-10-21T12:00:00Z" },
    stop: { runId: "original", status: "cancelled", acknowledgementMatches: true,
      samples: [0, 2500, 5000].map(ms => ({ at: new Date(Date.parse("2026-10-21T12:00:01Z") + ms).toISOString(), runIds: ["original"], automaticPath: false })),
      resumeSubmittedAt: "2026-10-21T12:00:07Z" },
    final: { runIds: ["original", "resumed"], resumedRunId: "resumed", workspaceId: "workspace", sourceUnchanged: true, resultVerified: true,
      issueDone: true, resumeCommentBound: true, originalStillCancelled: true, committed: true, startedAt: "2026-10-21T12:00:08Z",
      instructionsDigest: "a".repeat(64), toolFingerprint: `sha256:${"b".repeat(64)}`, finalDeliveryCount: 1, deliveryReceiptMatches: true, visibleDelivery: true, pendingInteractions: 0 } };
}
const passes = (value: FollowupStopObservation) => gradeFollowupStopResume(value).every(check => check.passed);

describe("one task across follow-up, Stop and explicit resumption", () => {
  it("requires the complete combined sequence and independently checked result", () => expect(passes(fixture())).toBe(true));
  it.each([
    ["no original checkpoint", (v: FollowupStopObservation) => { v.initial = null; }],
    ["invalid checkpoint", (v: FollowupStopObservation) => { v.initial!.checkpointVerified = false; }],
    ["no active follow-up", (v: FollowupStopObservation) => { v.followup = null; }],
    ["duplicate user message", (v: FollowupStopObservation) => { v.followup!.commentIds.push("duplicate"); }],
    ["different active run", (v: FollowupStopObservation) => { v.followup!.runId = "foreign"; }],
    ["follow-up after completion", (v: FollowupStopObservation) => { v.followup!.runStatus = "succeeded"; }],
    ["result before Stop", (v: FollowupStopObservation) => { v.followup!.acceptedResults = 1; }],
    ["no actual provider turn", (v: FollowupStopObservation) => { v.followup!.providerStarted = false; }],
    ["no Stop", (v: FollowupStopObservation) => { v.stop = null; }],
    ["unacknowledged Stop", (v: FollowupStopObservation) => { v.stop!.acknowledgementMatches = false; }],
    ["Stop cancelled another run", (v: FollowupStopObservation) => { v.stop!.runId = "foreign"; }],
    ["no quiet observation", (v: FollowupStopObservation) => { v.stop!.samples = []; }],
    ["insufficient quiet window", (v: FollowupStopObservation) => { v.stop!.samples.pop(); }],
    ["automatic wake after Stop", (v: FollowupStopObservation) => { v.stop!.samples[1]!.automaticPath = true; }],
    ["extra run before user resumes", (v: FollowupStopObservation) => { v.stop!.samples[1]!.runIds.push("unexpected"); }],
    ["no user resumption", (v: FollowupStopObservation) => { v.stop!.resumeSubmittedAt = null; }],
    ["new run before user resumption", (v: FollowupStopObservation) => { v.final!.startedAt = "2026-10-21T12:00:02Z"; }],
    ["unbound resume message", (v: FollowupStopObservation) => { v.final!.resumeCommentBound = false; }],
    ["missing final result", (v: FollowupStopObservation) => { v.final = null; }],
    ["duplicate resumed work", (v: FollowupStopObservation) => { v.final!.runIds.push("duplicate"); }],
    ["reused original cancelled run", (v: FollowupStopObservation) => { v.final!.resumedRunId = "original"; }],
    ["rewritten cancelled result", (v: FollowupStopObservation) => { v.final!.originalStillCancelled = false; }],
    ["different workspace", (v: FollowupStopObservation) => { v.final!.workspaceId = "new"; }],
    ["changed context file", (v: FollowupStopObservation) => { v.final!.sourceUnchanged = false; }],
    ["lost earlier follow-up", (v: FollowupStopObservation) => { v.final!.resultVerified = false; }],
    ["changed production instructions", (v: FollowupStopObservation) => { v.final!.instructionsDigest = "c".repeat(64); }],
    ["changed tool contract", (v: FollowupStopObservation) => { v.final!.toolFingerprint = `sha256:${"c".repeat(64)}`; }],
    ["duplicate final reply", (v: FollowupStopObservation) => { v.final!.finalDeliveryCount = 2; }],
    ["wrong final receipt", (v: FollowupStopObservation) => { v.final!.deliveryReceiptMatches = false; }],
    ["inaccessible final result", (v: FollowupStopObservation) => { v.final!.visibleDelivery = false; }],
    ["unanswered question", (v: FollowupStopObservation) => { v.final!.pendingInteractions = 1; }],
  ] as const)("rejects %s", (_label, mutate) => { const value = fixture(); mutate(value); expect(passes(value)).toBe(false); });
  it("checks exact downloaded fields without trusting a provider success claim", () => {
    const expected = { reference: "retained", label: "latest" };
    expect(exactSyntheticJson(JSON.stringify(expected), expected)).toBe(true);
    for (const body of ["unparseable", "[]", JSON.stringify({ ...expected, reference: "new" }),
      JSON.stringify({ ...expected, label: "old" }), JSON.stringify({ ...expected, extra: "unexpected" })])
      expect(exactSyntheticJson(body, expected)).toBe(false);
  });
  it("registers two isolated local development cells without claiming staging or Slack qualification", () => {
    const cells = runnerMatrix.filter(cell => cell.suite.id === "followup-stop-resume");
    expect(cells).toHaveLength(2);
    expect(new Set(cells.map(cell => cell.profile.model))).toEqual(new Set(["gpt-6.1-sol", "claude-opus-5-5"]));
    expect(cells.every(cell => cell.environment.id === "local" && cell.suite.manualOnly && cell.suite.groups.length === 0 &&
      cell.suite.definitionMetadata?.stagingQualification === false && cell.task.automaticRetryPolicy === "single_attempt")).toBe(true);
  });
});

it("observes the actual active provider through its durable turn rather than a finalization phase label", () => {
  const run = { id: "run", status: "running", nativePhase: "observed" };
  const started = { runId: "run", eventType: "turn.started", sourceKind: "runner" };
  expect(isActiveStopCheckpointRun(run, [started])).toBe(true);
  const prepared = { ...run, nativePhase: "provider_running" };
  expect(isActiveStopCheckpointRun(prepared, [started])).toBe(true);
  for (const candidate of [undefined, { ...run, status: "queued" }, { ...run, status: "succeeded" }])
    expect(isActiveStopCheckpointRun(candidate, [started])).toBe(false);
  for (const events of [[], [started, started], [{ ...started, runId: "foreign" }], [{ ...started, sourceKind: "control_plane" }],
    ...["run.result.accepted", "run.terminal", "turn.completed", "turn.failed", "turn.cancelled"].map(eventType => [started, { runId: "run", eventType }])])
    expect(isActiveStopCheckpointRun(run, events)).toBe(false);
});


it("keeps the recorded task binding during preparation without treating an absent native binding as foreign work", () => {
  const binding = { companyId: "company", agentId: "agent", issueId: "task" };
  const queued = { ...binding, nativeIssueId: null, contextSnapshot: { issueId: "task" }, runtimeMode: "legacy", runtimeModeResolvedAt: null };
  expect(stopRunBelongsToTask(queued, binding)).toBe(true);
  const selected = { ...queued, nativeIssueId: "task", runtimeMode: "native" };
  expect(stopRunBelongsToTask(selected, binding)).toBe(true);
  for (const run of [{ ...queued, companyId: "foreign" }, { ...queued, agentId: "foreign" },
    { ...queued, issueId: "foreign" }, { ...queued, nativeIssueId: "foreign" },
    { ...queued, contextSnapshot: { issueId: "foreign" } }, { ...queued, nativeIssueId: "" },
    { ...queued, issueId: undefined, contextSnapshot: null }]) expect(stopRunBelongsToTask(run, binding)).toBe(false);
});

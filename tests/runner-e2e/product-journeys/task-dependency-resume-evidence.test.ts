import { describe, expect, it } from "vitest";
import { dependencyOutputMatches, gradeTaskDependencyResume, TASK_DEPENDENCY_RESUME_CHECKS, type DependencyEvidence } from "./task-dependency-resume-evidence.js";
import { dependencyEvidenceFixture } from "./task-dependency-resume-fixture.js";

describe("task dependency resume evidence", () => {
  it("accepts a finite blocked observation followed by one automatic, attributed native result", () => {
    const checks = gradeTaskDependencyResume(dependencyEvidenceFixture());
    expect(checks).toEqual(TASK_DEPENDENCY_RESUME_CHECKS.map(id => ({ id, passed: true })));
  });
  const changeRuns = (f: DependencyEvidence, mutate: (run: Record<string, any>) => void) => {
    for (const point of [f.finished, f.reopened]) for (const run of [...point.dependentRuns, ...point.agentRuns]) mutate(run);
  };
  it.each([
    ["provider", (f: DependencyEvidence) => changeRuns(f, run => { run.runnerProfileJson.nativeExecutionInput.provider.kind = "other"; }), "configured-model-and-environment"],
    ["model", (f: DependencyEvidence) => changeRuns(f, run => { run.runnerProfileJson.nativeExecutionInput.provider.model = "other"; }), "configured-model-and-environment"],
    ["environment", (f: DependencyEvidence) => changeRuns(f, run => { run.contextSnapshot.paperclipEnvironment.id = "other"; }), "configured-model-and-environment"],
    ["runtime mode", (f: DependencyEvidence) => changeRuns(f, run => { run.runtimeMode = "legacy"; }), "configured-model-and-environment"],
    ["uncommitted phase", (f: DependencyEvidence) => changeRuns(f, run => { run.nativePhase = "saving"; }), "configured-model-and-environment"],
    ["document author", (f: DependencyEvidence) => { f.finished.document!.createdByUserId = "user"; }, "dependency-output-authored-by-run"],
    ["revision run", (f: DependencyEvidence) => { f.finished.revision!.createdByRunId = "foreign"; }, "dependency-output-authored-by-run"],
    ["reload visibility", (f: DependencyEvidence) => { f.reopened.resultVisible = false; }, "dependency-result-reopened"],
    ["activity coverage", (f: DependencyEvidence) => { f.reopened.activityCoverage.agent = false; }, "dependency-history-preserved"],
    ["extra child work", (f: DependencyEvidence) => { f.reopened.activity.push({ runId: "run", action: "issue.created" }); }, "dependency-history-preserved"],
    ["retained completion", (f: DependencyEvidence) => { f.reopened.blocker.completedAt = "2020-01-01T00:00:22.000Z"; }, "dependency-history-preserved"],
  ] as const)("attributes the %s defect to its own evidence check", (_name, mutate, failedId) => {
    const f = dependencyEvidenceFixture(); mutate(f);
    expect(gradeTaskDependencyResume(f).filter(check => !check.passed).map(check => check.id)).toEqual([failedId]);
  });
  const mutants: Array<[string, (value: DependencyEvidence) => void]> = [
    ["missing observation", f => { f.waiting = []; }],
    ["short quiet window", f => { f.waiting[1]!.observedAt--; }],
    ["non-monotonic observation", f => { f.waiting.reverse(); }],
    ["quiet window before creation", f => { f.created.observedAt = f.waiting[0]!.observedAt + 1; }],
    ["release before final quiet read", f => { f.releaseRequestedAt = f.waiting[1]!.observedAt - 1; }],
    ["blocker not completed", f => { f.released.blocker.status = "todo"; }],
    ["wrong board actor", f => { f.reopened.activity[0]!.actorId = "foreign"; }],
    ["agent claimed board completion", f => { f.reopened.activity[0]!.actorType = "agent"; }],
    ["missing board completion audit", f => { f.reopened.activity = []; }],
    ["duplicate board completion", f => { f.reopened.activity.push({ ...f.reopened.activity[0] }); }],
    ["wrong blocker relation", f => { f.waiting[0]!.dependent.blockedByIssueIds = ["foreign"]; }],
    ["removed relation after completion", f => { f.reopened.dependent.blockedByIssueIds = []; }],
    ["parked backlog instead of blocked", f => { f.waiting[0]!.dependent.status = "backlog"; }],
    ["premature execution", f => { f.waiting[0]!.dependentRuns = [f.finished.dependentRuns[0]!]; }],
    ["unknown work on owned agent", f => { f.waiting[0]!.agentRuns = [f.finished.agentRuns[0]!]; }],
    ["blocker ran an agent", f => { f.reopened.blockerRuns = [f.finished.dependentRuns[0]!]; }],
    ["dependency never resumed", f => { f.finished.dependent.status = "blocked"; }],
    ["duplicate native run", f => { f.reopened.dependentRuns.push({ ...f.reopened.dependentRuns[0], id: "extra" }); }],
    ["native run preceded blocker completion", f => { f.finished.dependentRuns[0]!.startedAt = "2020-01-01T00:00:19.000Z"; }],
    ["manual run instead of automatic resume", f => { f.finished.dependentRuns[0]!.invocationSource = "on_demand"; }],
    ["wrong wake reason", f => { f.finished.dependentRuns[0]!.contextSnapshot.wakeReason = "issue_assigned"; }],
    ["mutation name used as wake source", f => { for (const p of [f.finished, f.reopened]) for (const r of [...p.dependentRuns, ...p.agentRuns]) r.contextSnapshot.source = "issue.blocker_done"; }],
    ["missing saved wake source", f => { for (const p of [f.finished, f.reopened]) for (const r of [...p.dependentRuns, ...p.agentRuns]) delete r.contextSnapshot.source; }],
    ["wrong resolved blocker", f => { f.finished.dependentRuns[0]!.contextSnapshot.resolvedBlockerIssueId = "foreign"; }],
    ["conflicting native issue binding", f => { f.finished.dependentRuns[0]!.issueId = "foreign"; }],
    ["reopened run changed status", f => { f.reopened.dependentRuns[0]!.status = "running"; }],
    ["reopened native work still owns checkout", f => { f.reopened.dependent.executionRunId = "run"; }],
    ["wrong provider", f => { f.finished.dependentRuns[0]!.runnerProfileJson.nativeExecutionInput.provider.kind = "other"; }],
    ["wrong model", f => { f.finished.dependentRuns[0]!.runnerProfileJson.nativeExecutionInput.provider.model = "other"; }],
    ["wrong environment", f => { f.finished.dependentRuns[0]!.contextSnapshot.paperclipEnvironment.id = "other"; }],
    ["uncommitted native phase", f => { for (const p of [f.finished, f.reopened]) for (const r of [...p.dependentRuns, ...p.agentRuns]) r.nativePhase = "saving"; }],
    ["missing native phase", f => { for (const p of [f.finished, f.reopened]) for (const r of [...p.dependentRuns, ...p.agentRuns]) delete r.nativePhase; }],
    ["incomplete activity coverage", f => { f.reopened.activityCoverage.agent = false; }],
    ["wrong saved reference", f => { f.finished.document!.body = '{"reference":"wrong","blockerIdentifier":"QA-1"}'; }],
    ["wrong document task", f => { f.finished.document!.issueId = "foreign"; }],
    ["board-authored document", f => { f.finished.document!.createdByUserId = "user"; }],
    ["revision from another run", f => { f.finished.revision!.createdByRunId = "foreign"; }],
    ["missing saved result", f => { delete f.finished.document; }],
    ["missing revision", f => { delete f.finished.revision; }],
    ["result not visible after reload", f => { f.reopened.resultVisible = false; }],
    ["replaced document after reload", f => { f.reopened.document!.id = "replacement"; }],
    ["reference leaked in task prompt", f => { f.scope.prompt += f.scope.reference; }],
    ["foreign creator", f => { f.created.dependent.createdByUserId = "foreign"; }],
    ["unrequested child work", f => { f.reopened.activity.push({ runId: "run", action: "issue.created" }); }],
  ];
  it.each(mutants)("rejects %s", (_name, mutate) => {
    const f = dependencyEvidenceFixture(); mutate(f);
    expect(gradeTaskDependencyResume(f).some(check => !check.passed)).toBe(true);
  });
  it("missing input never becomes a pass", () => { expect(gradeTaskDependencyResume(undefined).every(c => !c.passed)).toBe(true); });
  it.each([null, {}, { summary: "Compacted result" }])("accepts the public run projection without duplicate finalization metadata: %j", resultJson => {
    const f = dependencyEvidenceFixture();
    for (const point of [f.finished, f.reopened]) for (const run of [...point.dependentRuns, ...point.agentRuns]) run.resultJson = resultJson;
    expect(gradeTaskDependencyResume(f).every(check => check.passed)).toBe(true);
  });
  const withHistory = () => {
    const f = dependencyEvidenceFixture();
    const prior = { ...structuredClone(f.finished.agentRuns[0]!), id: "prior", nativeIssueId: "prior-task",
      contextSnapshot: { issueId: "prior-task" }, status: "failed", startedAt: "2019-12-31T23:00:00Z" };
    f.startingAgentRuns = [prior];
    for (const p of [f.created, ...f.waiting, f.released, f.finished, f.reopened]) p.agentRuns.push(structuredClone(prior));
    return f;
  };
  it("retains completed earlier campaign work while measuring only new runs", () => {
    const f = withHistory();
    expect(gradeTaskDependencyResume(f).every(check => check.passed)).toBe(true);
    expect(f.reopened.agentRuns.map(run => run.id)).toEqual(["run", "prior"]);
  });
  it.each([
    ["missing baseline", (f: DependencyEvidence) => { delete (f as Partial<DependencyEvidence>).startingAgentRuns; }],
    ["foreign baseline", (f: DependencyEvidence) => { f.startingAgentRuns[0]!.agentId = "foreign"; }],
    ["active baseline", (f: DependencyEvidence) => { f.startingAgentRuns[0]!.status = "running"; }],
    ["baseline run disappeared", (f: DependencyEvidence) => { f.waiting[0]!.agentRuns = []; }],
    ["duplicate baseline ID", (f: DependencyEvidence) => { f.startingAgentRuns.push(f.startingAgentRuns[0]!); }],
    ["premature run hidden as prior work", (f: DependencyEvidence) => { f.startingAgentRuns.push(structuredClone(f.finished.dependentRuns[0]!)); }],
    ["new unrelated run while blocked", (f: DependencyEvidence) => { f.waiting[0]!.agentRuns.push({ ...structuredClone(f.startingAgentRuns[0]!), id: "extra" }); }],
  ] as const)("rejects %s", (_name, mutate) => {
    const f = withHistory(); mutate(f);
    expect(gradeTaskDependencyResume(f).some(check => !check.passed)).toBe(true);
  });
  it("has no global activity length cap after complete scoped observation", () => {
    const f = dependencyEvidenceFixture();
    f.reopened.activity.push(...Array.from({ length: 600 }, (_, i) => ({ id: `prior-${i}`, companyId: f.scope.companyId,
      entityType: "issue", entityId: f.scope.dependentId, action: "issue.observed" })));
    expect(gradeTaskDependencyResume(f).every(check => check.passed)).toBe(true);
  });
  it("accepts plain or fenced JSON but rejects extra keys and prose", () => {
    const s = dependencyEvidenceFixture().scope, body = JSON.stringify({ reference: s.reference, blockerIdentifier: s.blockerIdentifier });
    expect(dependencyOutputMatches(body, s)).toBe(true);
    expect(dependencyOutputMatches(`\`\`\`json\n${body}\n\`\`\``, s)).toBe(true);
    expect(dependencyOutputMatches(JSON.stringify({ reference: s.reference, blockerIdentifier: s.blockerIdentifier, extra: true }), s)).toBe(false);
    expect(dependencyOutputMatches(`Completed ${body}`, s)).toBe(false);
  });
});

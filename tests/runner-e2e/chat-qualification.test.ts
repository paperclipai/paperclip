import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertActiveHandoff, assertAnswerFacts, assertCrashRecovered, assertWorkerIdentity } from "./chat-qualification.js";
import { runnerMatrix } from "./catalog.js";
import { buildRunnerE2EProcessEnvironment } from "./harness-env.js";

const run = { id: "old", nativeSessionId: "old-session", agentId: "original", companyId: "company", runtimeMode: "native", status: "cancelled", errorCode: "issue_reassigned", finishedAt: "2026-09-21T00:01:00Z", contextSnapshot: { issueId: "task" } };
const successor = { ...run, id: "next", agentId: "successor", status: "succeeded", startedAt: "2026-09-21T00:01:01Z" };
const before = { id: "task", assigneeAgentId: "original", description: "Preserve scope", projectId: null };
const plan = { body: "Friday REFERENCE", latestRevisionId: "revision" };
const handoff = { before, after: { ...before, status: "done", assigneeAgentId: "successor" }, oldRun: run, boundary: { ...run, status: "running" }, runs: [run, successor], successorId: "successor", planBefore: plan, planAfter: plan, draft: { id: "draft", latestRevisionId: "v1", body: "REFERENCE" }, draftAfter: { id: "draft", body: "REFERENCE" }, draftRevisions: [{ id: "v1", body: "REFERENCE" }], output: { body: "REFERENCE", createdByAgentId: "successor" }, reference: "REFERENCE", audit: [{ action: "issue.reassigned", details: { source: "paperclip_runner_protocol" } }], taskIds: ["task"] };
const recovery = { boundary: { ...run, status: "running" }, failed: { ...run, status: "failed" }, runs: [{ ...run, status: "failed" }, { ...successor, agentId: "original", nativeSessionId: "fresh-session", contextSnapshot: { issueId: "task", previousRunId: "old", forceFreshSession: true } }], issueId: "task", prompt: "Read my brief", comments: [{ body: "Read my brief" }, { body: "REFERENCE MARKER", authorAgentId: "original", createdByRunId: "next" }], reference: "REFERENCE", marker: "MARKER", planBefore: { body: "plan MARKER", latestRevisionId: "v1" }, planAfter: { body: "plan MARKER", latestRevisionId: "v1" } };

describe("remaining native chat qualification", () => {
  it("calibrates the pidfd helper against reuse and wrong-identity faults", () => {
    execFileSync("python3", [path.join(import.meta.dirname, "worker-fault.test.py")], { stdio: "pipe" });
  });
  it("requires a stopped original worker before exactly one successor executes", () => {
    expect(() => assertActiveHandoff(handoff)).not.toThrow();
    expect(() => assertActiveHandoff({ ...handoff, draftAfter: { id: "draft", body: "Expanded REFERENCE" },
      output: { body: "Expanded REFERENCE", createdByAgentId: "original", updatedByAgentId: "successor" } })).not.toThrow();
    for (const change of [
      { boundary: { ...handoff.boundary, status: "succeeded" } },
      { oldRun: { ...run, status: "succeeded" } },
      { oldRun: { ...run, errorCode: "unrelated_cancellation" } },
      { runs: [run, { ...successor, startedAt: "2026-09-21T00:00:59Z" }] },
      { runs: [run, successor, { ...successor, id: "duplicate" }] },
      { runs: [run] },
      { taskIds: ["replacement"] },
      { planAfter: { ...plan, body: "rewritten" } },
      { draft: { body: "no saved progress" } },
      { draftAfter: { id: "replaced", body: "REFERENCE" } },
      { draftRevisions: [] },
      { draftRevisions: [{ id: "v1", body: "overwritten original" }] },
      { output: { body: "REFERENCE", createdByAgentId: "original" } },
      { audit: [] },
    ]) expect(() => assertActiveHandoff({ ...handoff, ...change })).toThrow();
  });
  it("requires successful run-attributed recovery preserving input and saved work", () => {
    expect(() => assertCrashRecovered(recovery)).not.toThrow();
    for (const change of [
      { boundary: { ...recovery.boundary, status: "succeeded" } },
      { failed: { ...recovery.failed, id: "unrelated" } },
      { runs: [recovery.runs[0]!, { ...successor, status: "failed" }] },
      { runs: [recovery.runs[0]!, { ...successor, contextSnapshot: { issueId: "new-chat" } }] },
      { runs: [recovery.runs[0]!, { ...recovery.runs[1]!, nativeSessionId: "old-session" }] },
      { runs: [recovery.runs[0]!, { ...recovery.runs[1]!, contextSnapshot: { issueId: "task", previousRunId: "unrelated", forceFreshSession: true } }] },
      { comments: [...recovery.comments, recovery.comments[0]!] },
      { comments: [recovery.comments[0]!, { ...recovery.comments[1], createdByRunId: "old" }] },
      { comments: [recovery.comments[0]!, { ...recovery.comments[1], body: "MARKER" }] },
      { planAfter: { ...recovery.planAfter, latestRevisionId: "rewritten" } },
    ]) expect(() => assertCrashRecovered({ ...recovery, ...change })).toThrow();
  });
  it("refuses unknown PIDs, nonnative or nonlocal processes and partial run identities", () => {
    const running = { id: "run-123", status: "running", runtimeMode: "native", processPid: 123456 };
    expect(() => assertWorkerIdentity(running, "node runner --run-id run-123 --worker", "local")).not.toThrow();
    for (const command of ["node server", "node runner --run-id run-1234", "node runner run-123 --run-id other"])
      expect(() => assertWorkerIdentity(running, command, "local")).toThrow();
    for (const processPid of [undefined, 0, 1, -20, process.pid, 1.2])
      expect(() => assertWorkerIdentity({ ...running, processPid }, "node runner --run-id run-123", "local")).toThrow();
    expect(() => assertWorkerIdentity(running, "node runner --run-id run-123", "daytona")).toThrow();
    expect(() => assertWorkerIdentity({ ...running, runtimeMode: "legacy" }, "node runner --run-id run-123", "local")).toThrow();
  });
  it("grades factual propositions rather than matching words in misleading prose", () => {
    const facts = { currentBlocker: "VENUE", confirmedAttendance: null, printingStarted: false };
    const explanation = "The venue is still unconfirmed, so printing remains deferred. No attendance count is recorded.";
    expect(() => assertAnswerFacts(JSON.stringify({ facts, explanation }), facts)).not.toThrow();
    for (const wrong of [
      { ...facts, currentBlocker: "BUDGET" }, { ...facts, confirmedAttendance: 40 },
      { ...facts, printingStarted: true }, { ...facts, madeUpMetric: 50 }, {},
    ]) expect(() => assertAnswerFacts(JSON.stringify({ facts: wrong, explanation }), facts)).toThrow();
    expect(() => assertAnswerFacts(JSON.stringify({ facts, explanation: "" }), facts)).toThrow();
    expect(() => assertAnswerFacts("VENUE confirmedAttendance null printingStarted false", facts)).toThrow();
  });
  it("exposes exactly six explicit local native cells with bounded run counts", () => {
    const cells = runnerMatrix.filter(c => c.suite.id === "agent-chat-qualification");
    expect(cells).toHaveLength(6);
    for (const cell of cells) {
      expect(cell.suite.manualOnly).toBe(true);
      expect(cell.environment.id).toBe("local");
      expect(cell.profile.generation).toBe("native");
      expect(cell.task.expectedRunCount).toBe(cell.task.id === "active-reassignment" ? 3 : 2);
      expect(buildRunnerE2EProcessEnvironment({}, [cell]).PAPERCLIP_RUNNER_API_TOOLS_ENABLED)
        .toBe(cell.task.id === "grounded-answer-quality" ? "true" : undefined);
    }
  });
});

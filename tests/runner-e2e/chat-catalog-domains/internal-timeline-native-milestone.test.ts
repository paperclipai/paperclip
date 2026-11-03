import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
vi.mock("../codex-subscription-fixture.js", () => ({ codexSubscriptionAgentConfig: (value: unknown) => value }));
import { gradeWorkTimeline } from "./internal-work-timeline.js";

function producer(status: "blocked" | "done", runId: string, decisionId: string) {
  const source = readFileSync(new URL("../../../server/src/services/native-runtime/status-decision-committer.ts", import.meta.url), "utf8");
  const marker = "const { publication } = await persistActivity(tx as unknown as Db, ";
  const anchor = source.lastIndexOf('actorId: "native-status-committer"');
  expect(anchor).toBeGreaterThan(0);
  const start = source.lastIndexOf(marker, anchor) + marker.length;
  const end = source.indexOf("\n    });", anchor);
  expect(end).toBeGreaterThan(start);
  // Execute only the actual committed event-object projection, no server/DB import.
  return runInNewContext("(" + source.slice(start, end) + "\n})", {
    input: { companyId: "company", issueId: "task", runId, assessmentId: "assessment-" + runId, decision: { statusAction: "transition", toStatus: status } },
    issue: { status: "in_progress" }, decisionRow: { id: decisionId }, reasonCode: "work_report", materialized: [],
  }, { timeout: 100 }) as Record<string, unknown>;
}
function fixture() {
  const first = { id: "first", companyId: "company", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "task" }, resultJson: { decisionId: "block-decision", assessmentId: "assessment-first", issueStatusBefore: "in_progress", issueStatusAfter: "blocked" } };
  const second = { ...first, id: "second", agentId: "riley", resultJson: { decisionId: "done-decision", assessmentId: "assessment-second", issueStatusBefore: "in_progress", issueStatusAfter: "done" } };
  const blocked = { id: "task", companyId: "company", status: "blocked", assigneeAgentId: "morgan", lastStatusDecisionId: "block-decision" };
  const done = { ...blocked, status: "done", assigneeAgentId: "riley", lastStatusDecisionId: "done-decision" };
  const blockedEvent = { ...producer("blocked", "first", "block-decision"), id: "blocked", createdAt: "2026-10-26T01:00:00Z" };
  const doneEvent = { ...producer("done", "second", "done-decision"), id: "done", createdAt: "2026-10-26T03:00:00Z" };
  return { scenarioId: "activity.work-timeline", origin: "https://fixture.test", companyId: "company", leadId: "ceo",
    state: { task: done, prepTask: { id: "prep" }, hiddenTask: { id: "hidden", title: "Protected acquisition" }, firstRun: first, secondRun: second, blockedTask: blocked,
      blockedEventId: "blocked", handoffEventId: "handoff", doneEventId: "done", today: "2026-10-26", timezone: "UTC", zoneLabel: "UTC", personId: "person" },
    tasks: [done, { id: "prep" }], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [], humanQueries: [],
    runs: [first, second], links: ["/RUN/issues/task", "/RUN/issues/prep"],
    reply: "Today (UTC): verification failed and work paused. Then the handoff went to Riley. The label was repaired and the check passed.",
    hiddenStatus: 404, timelineEvents: [blockedEvent, { id: "handoff", entityId: "task", action: "issue.updated", actorType: "user", actorId: "person", details: { assigneeAgentId: "riley" }, createdAt: "2026-10-26T02:00:00Z" }, doneEvent],
    verification: [{ taskId: "task", runId: "first", filename: "launch.html", sha256: "before", exitCode: 1, checkedAt: "2026-10-26T00:50:00Z" }, { taskId: "task", runId: "second", filename: "launch.html", sha256: "after", exitCode: 0, checkedAt: "2026-10-26T02:50:00Z" }],
  };
}
it("grades the actual producer's native status events through the real owning timeline oracle", () => {
  const o = fixture();
  expect(o.timelineEvents[0]).toMatchObject({ actorType: "system", actorId: "native-status-committer", runId: "first", details: { source: "native_status_decision", toStatus: "blocked" } });
  expect(gradeWorkTimeline(o).passed).toBe(true);
});
it.each(["companyId", "entityId", "runId", "actorId", "actorType", "source", "toStatus", "decisionId", "assessmentId"] as const)("rejects a wrong native event %s rather than accepting any system status event", field => {
  const o = fixture(), event = o.timelineEvents[0] as Record<string, unknown>;
  if (["source", "toStatus", "decisionId", "assessmentId"].includes(field)) (event.details as Record<string, unknown>)[field] = "foreign";
  else event[field] = "foreign";
  expect(gradeWorkTimeline(o).passed).toBe(false);
});
it.each(["worker", "missingWorker", "source", "contradictorySource", "status", "decision", "assessment", "resultStatus", "taskDecision", "assignee", "currentStatus"] as const)("rejects missing or unrelated accepted run/task proof %s", fault => {
  const o = fixture();
  if (fault === "worker") o.state.firstRun.agentId = "foreign";
  if (fault === "missingWorker") Reflect.deleteProperty(o.state.firstRun, "agentId");
  if (fault === "contradictorySource") Object.assign(o.state.firstRun.contextSnapshot, { taskId: "foreign" });
  if (fault === "source") o.state.firstRun.contextSnapshot.issueId = "foreign";
  if (fault === "status") o.state.firstRun.status = "running";
  if (fault === "decision") o.state.firstRun.resultJson.decisionId = "foreign";
  if (fault === "assessment") o.state.firstRun.resultJson.assessmentId = "foreign";
  if (fault === "resultStatus") o.state.firstRun.resultJson.issueStatusAfter = "done";
  if (fault === "taskDecision") o.state.blockedTask.lastStatusDecisionId = "foreign";
  if (fault === "assignee") o.state.blockedTask.assigneeAgentId = "foreign";
  if (fault === "currentStatus") o.state.blockedTask.status = "done";
  expect(gradeWorkTimeline(o).passed).toBe(false);
});
it("still rejects fake command exits, unchanged bytes and unobserved human handoff", () => {
  const wrongExit = fixture(); wrongExit.verification[0]!.exitCode = 0; expect(gradeWorkTimeline(wrongExit).passed).toBe(false);
  const sameBytes = fixture(); sameBytes.verification[1]!.sha256 = "before"; expect(gradeWorkTimeline(sameBytes).passed).toBe(false);
  const wrongHuman = fixture(); (wrongHuman.timelineEvents[1] as Record<string, unknown>).actorId = "foreign"; expect(gradeWorkTimeline(wrongHuman).passed).toBe(false);
});

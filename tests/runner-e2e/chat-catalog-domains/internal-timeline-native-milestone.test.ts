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
    state: { worker: { id: "morgan", name: "Morgan" }, repairWorker: { id: "riley", name: "Riley" }, task: done, prepTask: { id: "prep" }, hiddenTask: { id: "hidden", title: "Protected acquisition" }, firstRun: first, secondRun: second, blockedTask: blocked,
      blockedEventId: "blocked", handoffEventId: "handoff", doneEventId: "done", today: "2026-10-26", timezone: "UTC", zoneLabel: "UTC", personId: "person", personName: "Avery" },
    tasks: [done, { id: "prep" }], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [], humanQueries: [],
    runs: [first, second], links: ["/RUN/issues/task", "/RUN/issues/prep"],
    reply: "Today (UTC): Morgan ran verification which failed and work paused. Then a human reassigned the task to Riley. Riley repaired the label and the check passed.",
    hiddenStatus: 404, timelineEvents: [blockedEvent, { id: "handoff", entityId: "task", action: "issue.updated", actorType: "user", actorId: "person", details: { assigneeAgentId: "riley" }, createdAt: "2026-10-26T02:00:00Z" }, doneEvent],
    verification: [{ taskId: "task", runId: "first", filename: "launch.html", command: "node accessible-heading-and-email-label-check", sha256: "a".repeat(64), exitCode: 1, checkedAt: "2026-10-26T00:50:00Z" }, { taskId: "task", runId: "second", filename: "launch.html", command: "node accessible-heading-and-email-label-check", sha256: "b".repeat(64), exitCode: 0, checkedAt: "2026-10-26T02:50:00Z" }],
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
  const sameBytes = fixture(); sameBytes.verification[1]!.sha256 = "a".repeat(64); expect(gradeWorkTimeline(sameBytes).passed).toBe(false);
  const wrongHuman = fixture(); (wrongHuman.timelineEvents[1] as Record<string, unknown>).actorId = "foreign"; expect(gradeWorkTimeline(wrongHuman).passed).toBe(false);
});

it.each([
  "Today (UTC): Morgan's verification command failed and work paused. A human reassigned the task to Riley. Riley repaired the label and verification passed.",
  "Today (UTC): Morgan's check returned exit code 1; the task was blocked. The operator handed the task over to Riley. Riley fixed the label; the command succeeded with exit code 0.",
  "Today (UTC): Morgan ran verification; the native run succeeded but its check failed and work paused. A human reassigned the task to Riley. Riley fixed the label and the command passed.",
  "Today (UTC): Morgan's verification failed and work paused. You reassigned the task to Riley. Riley fixed the label and the command passed. No native run failed.",
  "Today (UTC): Morgan's verification failed and work paused. Avery handed it to Riley. Riley fixed the label and the command passed. Neither native run failed.",
  "Today (UTC): Morgan's verification failed and work paused. The task was reassigned to Riley by Avery. Riley fixed the label and the command passed. Did a native run fail? Both native runs succeeded.",
  "Today (UTC): Morgan's verification failed and work paused. You reassigned the task to Riley. Riley fixed the label and the command passed. If a native run failed, it would be recorded; both native runs succeeded.",
  "Today (UTC): Overview: Riley completed the repair. First Morgan's verification failed and the task was blocked. Then the board reassigned the task to Riley. Riley fixed the input and the check passed.",
])("accepts a complete attributed account regardless of incidental first mentions: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(true);
});
it.each([
  "Today (UTC): Morgan's verification failed and work paused. Riley repaired the label and the check passed.",
  "Today (UTC): Morgan's verification failed and work paused. The human reassigned the task to Morgan. Riley repaired the label and the check passed.",
  "Today (UTC): Morgan's verification failed and work paused. Riley reassigned the task to Riley. Riley repaired the label and the check passed.",
  "Today (UTC): Riley's verification failed and work paused. The human reassigned the task to Riley. Morgan repaired the label and the check passed.",
  "Today (UTC): The human reassigned the task to Riley. Morgan's verification failed and work paused. Riley repaired the label and the check passed.",
  "Today (UTC): Morgan's verification failed and work paused. The human reassigned the task to Morgan, and Riley repaired the label and the check passed.",
  "Today (UTC): Morgan's verification failed and work paused. Jordan reassigned the task to Riley. Riley repaired the label and the check passed.",
  "Today (UTC): Morgan's native run failed and work paused. The human reassigned the task to Riley. Riley repaired the label and the check passed.",
])("rejects missing, wrong or unordered consequential actors: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(false);
});
it.each(["missing link", "hidden work", "source mutation", "wrong command", "wrong file", "wrong task", "wrong run", "empty hash"])("preserves independent evidence and disclosure gates: %s", fault => {
  const o = fixture();
  if (fault === "missing link") o.links.pop();
  if (fault === "hidden work") o.reply += " Protected acquisition";
  if (fault === "source mutation") o.activity.push({ entityId: "task", agentId: "ceo", action: "issue.updated" } as never);
  if (fault === "wrong command") Object.assign(o.verification[0]!, { command: "echo success" });
  if (fault === "wrong file") o.verification[0]!.filename = "foreign.html";
  if (fault === "wrong task") o.verification[0]!.taskId = "foreign";
  if (fault === "wrong run") o.verification[0]!.runId = "foreign";
  if (fault === "empty hash") o.verification[0]!.sha256 = "";
  expect(gradeWorkTimeline(o).passed).toBe(false);
});

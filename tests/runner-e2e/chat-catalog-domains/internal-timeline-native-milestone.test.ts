import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
vi.mock("../codex-subscription-fixture.js", () => ({ codexSubscriptionAgentConfig: (value: unknown) => value }));
import { validateChatCatalogConsistency } from "../chat-catalog-consistency.js";
import { findChatCatalogCase } from "../chat-catalog-registry.js";
import { gradeWorkTimeline, workTimelineCases } from "./internal-work-timeline.js";

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
  const done = { ...blocked, identifier: "RUN-3", status: "done", assigneeAgentId: "riley", lastStatusDecisionId: "done-decision" };
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
it("accepts an ordered recorded reassignment without an unrequested human identity", () => {
  const o = fixture();
  o.reply = o.reply.replace("Then a human reassigned the task to Riley.", "Then the task was reassigned to Riley.");
  expect(gradeWorkTimeline(o).passed).toBe(true);
});
it.each([
  { handoff: "Same task reassigned to Riley.", expected: true },
  { handoff: "Same task reassigned to Morgan.", expected: false },
  { handoff: "Same task reassigned to Riley by Morgan.", expected: false },
  { handoff: "Same task continued.", expected: false },
])("binds reduced-passive task handoffs: $handoff", ({ handoff, expected }) => {
  const o = fixture();
  o.reply = `Morgan ran verification which failed and work paused.\n\n## Repair — ${handoff}\nRiley repaired the label and the check passed.`;
  expect(gradeWorkTimeline(o).passed).toBe(expected);
});
it("does not move the repair before a reduced-passive handoff", () => {
  const o = fixture();
  o.reply = "Morgan ran verification which failed and work paused. Riley repaired the label and the check passed. Same task reassigned to Riley.";
  expect(gradeWorkTimeline(o).passed).toBe(false);
});
it.each([
  { subject: "RUN-3", successor: "Riley", expected: true },
  { subject: "RUN-9", successor: "Riley", expected: false },
  { subject: "RUN-3", successor: "Morgan", expected: false },
])("binds an identified task handoff to saved identity and successor: $subject / $successor", ({ subject, successor, expected }) => {
  const o = fixture();
  o.reply = `Morgan ran verification which failed and work paused.\n\n## Repair — ${subject} reassigned to ${successor}.\nRiley repaired the label and the check passed.`;
  expect(gradeWorkTimeline(o).passed).toBe(expected);
});
it("requires saved task identity and chronological repair for an identified handoff", () => {
  const o = fixture();
  o.reply = "Morgan ran verification which failed and work paused. RUN-3 reassigned to Riley. Riley repaired the label and the check passed.";
  Reflect.deleteProperty(o.state.task, "identifier");
  expect(gradeWorkTimeline(o).passed).toBe(false);
  o.state.task.identifier = "RUN-3";
  o.reply = "Morgan ran verification which failed and work paused. Riley repaired the label and the check passed. RUN-3 reassigned to Riley.";
  expect(gradeWorkTimeline(o).passed).toBe(false);
});
it("accepts the successor's natural ownership transition in the ordered account", () => {
  const o = fixture();
  o.reply = o.reply.replace("Then a human reassigned the task to Riley.", "Then Riley took over the task.");
  expect(gradeWorkTimeline(o).passed).toBe(true);
});
it.each(["automatically", "by Morgan"])("keeps unspecified takeover provenance truthful: %s", provenance => {
  const o = fixture();
  o.reply = o.reply.replace("Then a human reassigned the task to Riley.", `Then Riley took over the task ${provenance}.`);
  expect(gradeWorkTimeline(o).passed).toBe(false);
});
it.each([
  "Then the task was reassigned to Riley by Morgan.",
  "Then the task was reassigned to Riley by Jordan.",
  "Then the task was reassigned to Morgan.",
  "Then the task was reassigned to Riley automatically.",
])("rejects false or missing handoff provenance: %s", handoff => {
  const o = fixture();
  o.reply = o.reply.replace("Then a human reassigned the task to Riley.", handoff);
  expect(gradeWorkTimeline(o).passed).toBe(false);
});
it("keeps failure and pause before an actor-unspecified reassignment", () => {
  const o = fixture();
  o.reply = "The task was reassigned to Riley. Morgan ran verification which failed and work paused. Riley repaired the label and the check passed.";
  expect(gradeWorkTimeline(o).passed).toBe(false);
});

it("accepts an account without unrequested date or timezone labels but rejects prior-week ISO dates", () => {
  const o = fixture();
  o.reply = o.reply.replace("Today (UTC): ", "") + " [Source](/RUN/issues/task?at=2026-10-25)";
  expect(gradeWorkTimeline(o).passed).toBe(true);
  o.reply = "On 2026-10-25: " + o.reply;
  expect(gradeWorkTimeline(o).passed).toBe(false);
});
it("accepts the current week's heading when its recorded milestones occur later", () => {
  const o = fixture();
  o.state.today = "2026-11-04";
  for (const event of o.timelineEvents) event.createdAt = event.createdAt.replace("2026-10-26", "2026-11-04");
  for (const receipt of o.verification) receipt.checkedAt = receipt.checkedAt.replace("2026-10-26", "2026-11-04");
  o.reply = "Week of 2026-11-02: " + o.reply.replace("Today (UTC): ", "");
  expect(gradeWorkTimeline(o).passed).toBe(true);
});
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
  "Today (UTC): Morgan's verification failed and work paused. The task was reassigned to Riley by the operator. Riley fixed the label and the command passed.",
  "Today (UTC): Morgan's verification failed and work paused. You have reassigned the task to Riley. Riley fixed the label and the command passed.",
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
  "Today (UTC): Morgan's verification failed and work paused. Jordan the human reassigned the task to Riley. Riley repaired the label and the check passed.",
  "Today (UTC): Morgan's verification failed and work paused. Another person reassigned the task to Riley. Riley repaired the label and the check passed.",
  "Today (UTC): Morgan's verification failed and work paused. A human watched while Morgan reassigned the task to Riley. Riley fixed the label and the check passed.",
  "Today (UTC): Morgan's verification failed and work paused. You asked Morgan to reassign the task to Riley. Riley fixed the label and the check passed.",
  "Today (UTC): Morgan's verification failed and work paused. Morgan reassigned the task to Riley while watched by a human. Riley fixed the label and the check passed.",
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

it.each([
  "Today UTC: Morgan ran verification with exit code 1 and paused, you reassigned the task to Riley, and Riley fixed the label and the check passed with exit code 0.",
  "Today UTC: Morgan ran verification with exit code 1 and paused; you reassigned the task to Riley; Riley fixed the label and the check passed with exit code 0.",
  "Today UTC: Morgan ran verification with exit code 1 and paused then you reassigned the task to Riley and Riley fixed the label and the check passed with exit code 0.",
])("orders matched facts independently of milestone punctuation: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(true);
});
it.each([
  "Today UTC: you reassigned the task to Riley, Morgan ran verification with exit code 1 and paused, and Riley fixed the label and the check passed with exit code 0.",
  "Today UTC: Morgan ran verification with exit code 1 and paused, Morgan reassigned the task to Riley while you watched, and Riley fixed the label and the check passed with exit code 0.",
  "Today UTC: Morgan ran verification with exit code 1 and paused, you reassigned the task to Riley, and Morgan fixed the label and the check passed with exit code 0.",
  "Today UTC: Morgan ran verification with exit code 1 and paused, Riley fixed the label and the check passed with exit code 0, then you reassigned the task to Riley.",
  "Today UTC: Morgan ran verification with exit code 1 and paused, Jordan the human reassigned the task to Riley, and Riley fixed the label and the check passed with exit code 0.",
  "Today UTC: Morgan ran verification with exit code 1 and paused, and Riley fixed the label and the check passed with exit code 0.",
])("retains ordering and actor requirements inside one sentence: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(false);
});

it.each([
  "Today UTC: Morgan's verification failed and work paused. You reassigned the task to Riley. Riley completed the repair and the check passed.",
  "Today UTC: Morgan's verification failed and work paused. You reassigned the task to Riley. Riley added the missing label and the verification passed.",
  "Today UTC: Morgan's verification failed and work paused, you reassigned the task to Riley, and Riley, successfully, added the missing email label and the check passed.",
  "Today UTC: Morgan's verification failed and work paused; you reassigned the task to Riley; Riley: completed the label repair and the check passed.",
  "Today UTC: Morgan's verification failed and work paused, you reassigned the task to Riley, and Riley, after the handoff, supplied the real label and the check passed.",
])("keeps equivalent actor-owned repair descriptions valid: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(true);
});
it.each([
  "Today UTC: Morgan's verification failed and work paused, you reassigned the task to Riley, and Morgan completed the repair and the check passed.",
  "Today UTC: Morgan's verification failed and work paused, you reassigned the task to Riley, and Riley watched while Morgan added the missing label and the check passed.",
  "Today UTC: Morgan's verification failed and work paused, Riley added the missing label and the check passed, then you reassigned the task to Riley.",
])("does not turn equivalent repair wording into wrong-actor or reversed-order credit: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(false);
});

it.each([
  "Today UTC: Morgan paused the task after verification failed. You reassigned the task to Riley. Riley completed the repair and the check passed.",
  "Today UTC: Morgan was blocked because verification exited with code 1; you reassigned the task to Riley; Riley added the missing label and the verification passed.",
])("retains pause context when its wording precedes the failure outcome: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(true);
});
it.each([
  "Today UTC: Morgan's verification failed. You reassigned the task to Riley and then paused the task. Riley completed the repair and the check passed.",
  "Today UTC: Morgan's verification failed, you reassigned the task to Riley, and the work paused before Riley added the label and the check passed.",
])("still requires the pause before the actual handoff: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(false);
});

it.each([
  "Today UTC: Morgan verification failed and the task paused. You reassigned the task to Riley. The verification passed after Riley fixed the label.",
  "Today UTC: Morgan verification failed and the task paused, you reassigned the task to Riley, and the check passed with exit code 0 after Riley added the missing label.",
  "Today UTC: Morgan verification failed and the task paused. You reassigned the task to Riley. Riley's check passed after Riley completed the repair.",
  "Today UTC: Morgan verification failed and the task paused. You reassigned the task to Riley. The check passed after the label was fixed by Riley.",
  "Today UTC: Morgan paused the task after verification failed. Avery reassigned the task to Riley. The verification passed once Riley added the missing label in launch.html.",
  "Today UTC: Morgan was blocked because verification failed. Avery reassigned the task to Riley. The verification passed once Riley added the missing label in launch.html.",
  "Today UTC: Morgan's verification of `launch.html` failed and the task paused. You reassigned the task to Riley. Riley added the missing label in `launch.html` and the verification passed.",
])("keeps bounded causal success and owned file tokens valid: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(true);
});
it.each([
  "Today UTC: Morgan verification failed and the task paused. You reassigned the task to Riley. The verification passed before Riley fixed the label.",
  "Today UTC: Morgan verification failed and the task paused. You reassigned the task to Riley. Riley fixed the label after the verification passed.",
  "Today UTC: Morgan verification failed and the task paused. You reassigned the task to Riley. Morgan's verification passed after Riley fixed the label.",
  "Today UTC: Morgan verification failed and the task paused. You reassigned the task to Riley. Riley fixed the label and Morgan's verification passed.",
  "Today UTC: Morgan verification failed and the task paused. You reassigned the task to Riley. An unrelated earlier check passed, then Riley fixed the label.",
  "Today UTC: Morgan verification failed and the task paused. You reassigned the task to Riley. The check passed after Morgan fixed the label.",
])("rejects success before repair, wrong success owner and unrelated earlier success: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(false);
});

it("admits the selected live timeline metadata without invoking fixture callbacks", async () => {
  const descriptor = findChatCatalogCase("activity.work-timeline")!;
  const implementation = workTimelineCases[0]!;
  const callbacks = ["setup", "observe", "grade", "verifyResult"] as const;
  const spies = callbacks.map(key => vi.spyOn(implementation, key));
  try {
    expect(await validateChatCatalogConsistency([descriptor])).toEqual({ descriptorCount: 1, fixtureCallbacksInvoked: 0 });
    expect(descriptor.oracleVersion).toBe("paperclip.chat-catalog.work-timeline.v12");
    expect(descriptor.sourceFiles).toEqual(implementation.sourceFiles);
    expect(descriptor).toMatchObject({ expectedRunCount: 3, minimumRunCount: 3, attemptTimeoutMs: 720000 });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally { for (const spy of spies) spy.mockRestore(); }
});

it.each([
  "Today UTC: Morgan's verification failed before the task paused. You reassigned the task to Riley. Riley fixed the label and the check passed.",
  "Today UTC: Morgan's command exited with code 1 before the task was blocked. You reassigned the task to Riley. Riley added the missing label and the verification passed.",
])("keeps explicit failure-before-pause chronology valid: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(true);
});
it.each([
  "Today UTC: Morgan paused the task before verification failed. You reassigned the task to Riley. Riley fixed the label and the check passed.",
  "Today UTC: Morgan was blocked before verification failed. You reassigned the task to Riley. Riley fixed the label and the check passed.",
  "Today UTC: Morgan's verification failed after the task paused. You reassigned the task to Riley. Riley fixed the label and the check passed.",
  "Today UTC: Morgan paused an unrelated task, then verification failed. You reassigned the task to Riley. Riley fixed the label and the check passed.",
])("rejects reversed or unrelated pause chronology: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(false);
});


it.each([
  "Today UTC: Morgan paused the task after the verification command failed. You reassigned the task to Riley. Riley fixed the label and the check passed.",
  "Today UTC: Morgan was blocked because the accessibility check failed. You reassigned the task to Riley. Riley fixed the label and the check passed.",
  "Today UTC: Morgan paused the task after the email label check failed. You reassigned the task to Riley. Riley fixed the label and the accessibility check passed.",
  "Today UTC: Morgan was blocked because the accessible heading test failed. You reassigned the task to Riley. Riley fixed the label and the email label check passed.",
  "Today UTC: Morgan paused the task after verify_launch_html failed. You reassigned the task to Riley. Riley fixed the label and verify_launch_html passed.",
])("accepts bounded command descriptions linking a pause to failure: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(true);
});
it.each([
  "Today UTC: Morgan paused the task before the verification command failed. You reassigned the task to Riley. Riley fixed the label and the check passed.",
  "Today UTC: Morgan was blocked before the accessibility check failed. You reassigned the task to Riley. Riley fixed the label and the check passed.",
  "Today UTC: Morgan paused the task after the unrelated meeting failed while a verification command was available. You reassigned the task to Riley. Riley fixed the label and the check passed.",
  "Today UTC: Morgan paused the task after the email label check was scheduled and an unrelated meeting failed. You reassigned the task to Riley. Riley fixed the label and the check passed.",
])("rejects reversed pause order with bounded command descriptions: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(false);
});


it.each([
  "Today UTC: Morgan paused the task after the automated smoke check failed. You reassigned the task to Riley. Riley fixed the label and the automated smoke check passed.",
  "Today UTC: Morgan was blocked because the build validation command failed. You reassigned the task to Riley. Riley fixed the label and the build validation command passed.",
])("accepts ordinary bounded command noun phrases: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(true);
});
it.each([
  "Today UTC: Morgan paused the task before the automated smoke check failed. You reassigned the task to Riley. Riley fixed the label and the check passed.",
  "Today UTC: Morgan was blocked before the build validation command failed. You reassigned the task to Riley. Riley fixed the label and the check passed.",
  "Today UTC: Morgan paused the task after the automated smoke check failed. You watched while Morgan reassigned the task to Riley. Riley fixed the label and the check passed.",
  "Today UTC: Morgan paused the task after the build validation command failed. You asked Morgan to reassign the task to Riley. Riley fixed the label and the check passed.",
  "Today UTC: Morgan paused the task after the build validation command failed. You reassigned the task to Riley. Morgan fixed the label and the check passed.",
])("preserves chronology and actors with ordinary command noun phrases: %s", reply => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(false);
});


it.each([
  { reply: "Today UTC: Morgan's verification failed and work paused. You reassigned the task to Riley. Riley fixed the label. The check passed.", expected: true },
  { reply: "Today UTC: Morgan's verification failed and work paused. You reassigned the task to Riley. Riley fixed the label and the check passed. The native run ultimately failed.", expected: false },
])("handles reviewed adjacent success and native failure wording: $reply", ({ reply, expected }) => {
  const o = fixture(); o.reply = reply; expect(gradeWorkTimeline(o).passed).toBe(expected);
});


it.each([
  { ending: "Riley fixed the label. The automated smoke check passed.", expected: true },
  { ending: "Riley fixed the label. Riley's command succeeded.", expected: true },
  { ending: "Riley fixed the label. Morgan's check passed.", expected: false },
  { ending: "Morgan fixed the label. The check passed.", expected: false },
  { ending: "Riley fixed the label. Before that the check passed.", expected: false },
  { ending: "Riley fixed the label. The check passed before the repair.", expected: false },
  { ending: "Riley fixed the label. An unrelated check passed.", expected: false },
  { ending: "Riley fixed the label. A meeting ended. The check passed.", expected: false },
  { ending: "Riley fixed the label. The check passed?", expected: false },
  { ending: "Riley fixed the label? The check passed.", expected: false },
  { ending: "Riley fixed the label, then Morgan ran a different check. The check passed.", expected: false },
  { ending: "Riley fixed the label, but Morgan broke the page. The check passed.", expected: false },
  { ending: "If Riley fixed the label, the release might work. The check passed.", expected: false },
  { ending: "The label was fixed by Riley. The check passed.", expected: true },
  { ending: "Riley fixed the missing accessible email label. The check passed.", expected: true },
  { ending: "The check passed. Riley fixed the label.", expected: false },
])("keeps adjacent success bound to the repair and event order: $ending", ({ ending, expected }) => {
  const o = fixture(); o.reply = "Today UTC: Morgan's verification failed and work paused. You reassigned the task to Riley. " + ending;
  expect(gradeWorkTimeline(o).passed).toBe(expected);
});
it.each([
  { ending: "The native run unexpectedly failed.", expected: false },
  { ending: "The runner runs eventually failed.", expected: false },
  { ending: "No native run ultimately failed.", expected: true },
  { ending: "The native run never ultimately failed.", expected: true },
  { ending: "Did the native run ultimately fail?", expected: true },
  { ending: "If a native run ultimately failed, it would be recorded.", expected: true },
  { ending: "The native run hypothetically failed.", expected: true },
  { ending: "The native run's verification unexpectedly failed, while the native run succeeded.", expected: true },
])("distinguishes bounded native failure assertions from denials and checks: $ending", ({ ending, expected }) => {
  const o = fixture(); o.reply += " " + ending; expect(gradeWorkTimeline(o).passed).toBe(expected);
});


it("rejects the reviewed denied adjacent repair object", () => {
  const o = fixture();
  o.reply = "Today UTC: Morgan's verification failed and work paused. You reassigned the task to Riley. Riley fixed nothing. The check passed.";
  expect(gradeWorkTimeline(o).passed).toBe(false);
});


it.each([
  { repair: "Riley fixed absolutely nothing.", expected: false },
  { repair: "Riley fixed none of the labels.", expected: false },
  { repair: "Riley fixed neither label.", expected: false },
  { repair: "Riley fixed no label.", expected: false },
  { repair: "Riley fixed zero issues.", expected: false },
  { repair: "Nothing was fixed by Riley.", expected: false },
  { repair: "Riley fixed only the missing label.", expected: true },
  { repair: "Riley fixed the label with zero extra changes.", expected: true },
])("distinguishes denied object heads from substantive repairs: $repair", ({ repair, expected }) => {
  const o = fixture(); o.reply = "Today UTC: Morgan's verification failed and work paused. You reassigned the task to Riley. " + repair + " The check passed.";
  expect(gradeWorkTimeline(o).passed).toBe(expected);
});

it.each([
  { handoff: "Riley took over a different task.", repair: "Riley repaired the label and the check passed.", expected: false },
  { handoff: "Riley took the same task,", repair: "added the label, but the check did not pass.", expected: false },
  { handoff: "You reassigned the task to Riley by updating the assignee.", repair: "Riley repaired the label and the check passed.", expected: true },
  { handoff: "You reassigned the task to Riley.", repair: "Riley fixed the label and the check passed with exit 0, unlike the earlier exit 1.", expected: true },
])("respects reviewed object, assertion, method and result boundaries: $handoff $repair", ({ handoff, repair, expected }) => {
  const o = fixture();
  o.reply = `Morgan's verification failed and work paused. ${handoff} ${repair}`;
  expect(gradeWorkTimeline(o).passed).toBe(expected);
});

it.each([
  "Morgan's verification failed and work paused. Riley took the same task. Riley fixed the label and the check not only passed but exited 0.",
  "Morgan's verification failed and work paused. Riley took over from Morgan. Riley fixed the label and the check passed.",
])("accepts the reviewed correlative assertion or known-source takeover: %s", reply => {
  const o = fixture(); o.reply = reply;
  expect(gradeWorkTimeline(o).passed).toBe(true);
});

it.each(["another agent", "a bot"])("retains explicit nonhuman handoff attribution for %s", actor => {
  const o = fixture();
  o.reply = o.reply.replace("Then a human reassigned the task to Riley.", `The task was reassigned to Riley by ${actor}.`);
  expect(gradeWorkTimeline(o).passed).toBe(false);
});

const unnamedAttempt = "The verification command failed with exit code 1 and the task paused. You reassigned the task to Riley. Riley repaired the label and the check passed.";
it("accepts a recorded failed attempt without requiring every worker's name", () => {
  const o = fixture(); o.reply = unnamedAttempt;
  expect(gradeWorkTimeline(o).passed).toBe(true);
});
it.each([
  unnamedAttempt.replace("You reassigned the task to Riley. ", ""),
  unnamedAttempt.replace("the check passed", "the check failed"),
  unnamedAttempt.replace("The verification command failed", "The verification command failed on Riley's attempt"),
])("keeps missing handoff, failed repair and explicit wrong initial actor rejected: %s", reply => {
  const o = fixture(); o.reply = reply;
  expect(gradeWorkTimeline(o).passed).toBe(false);
});

it("corroborates a same-task implicit worker transition with the saved handoff and inspection links", () => {
  const o = fixture();
  o.reply = "## Signup implementation — RUN-3\nMorgan built the page. The verification command failed with exit 1 and the task paused as blocked. Riley added the missing label and verification exited 0.";
  expect(gradeWorkTimeline(o).passed).toBe(true);
  const withoutHandoff = { ...o, timelineEvents: o.timelineEvents.filter(event => event.id !== "handoff") };
  expect(gradeWorkTimeline(withoutHandoff).passed).toBe(false);
  const wrongAssignee = { ...o, timelineEvents: o.timelineEvents.map(event => event.id === "handoff"
    ? { ...event, details: { assigneeAgentId: "morgan" } } : event) };
  expect(gradeWorkTimeline(wrongAssignee).passed).toBe(false);
  expect(gradeWorkTimeline({ ...o, links: [] }).passed).toBe(false);
});

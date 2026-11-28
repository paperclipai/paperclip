import { describe, expect, it } from "vitest";
import { gradeIntegratorCaseHandoff } from "./integrator-case-handoff.js";
import { shouldWakeAssigneeForIssueComment } from "../../../server/src/services/issue-comment-wakeup.js";
function valid() {
  const findings = { id: "findings", issueId: "primary", latestRevisionId: "original", body: "On mobile Safari, tapping Pay has no effect. Keyboard activation succeeds." };
  const row = { id: "case", workIssueId: "primary", handoffVersion: 1, status: "in_progress" };
  const runs = [{ id: "stopped", agentId: "morgan", status: "cancelled", contextSnapshot: { issueId: "primary" }, runtimeMode: "native", startedAt: "2026-10-26T10:00:00Z" },
    { id: "source", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "chat" }, runtimeMode: "native", startedAt: "2026-10-26T11:00:00Z" },
    { id: "owner", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "primary", wakeCommentId: "resume" }, runtimeMode: "native", startedAt: "2026-10-26T11:01:00Z" },
    { id: "review", agentId: "riley", status: "succeeded", contextSnapshot: { issueId: "primary" }, runtimeMode: "native", startedAt: "2026-10-26T11:02:00Z" }];
  const base = { scenarioId: "cases.handoff-same-task", origin: "https://fixture.test", companyId: "company", leadId: "morgan", state: { case: row, reviewer: { id: "riley" }, respondentId: "morgan", findings,
    interruptedRunId: "stopped", interruptedTask: { id: "primary", executionRunId: "stopped", assigneeAgentId: "morgan" } }, sourceIssueId: "chat", actingAgent: { id: "morgan", name: "Morgan", role: "engineer" }, reviewer: { id: "riley", name: "Riley", role: "engineer" },
    tasks: [{ id: "primary", assigneeAgentId: "riley", status: "done" }], projects: [], goals: [], documents: [], revisions: [], humanQueries: [], activity: [], links: [], runs,
    comments: [{ id: "resume", issueId: "primary", authorAgentId: "morgan", createdByRunId: "source" }, { id: "handoff-comment", issueId: "primary", authorAgentId: "morgan", createdByRunId: "owner" }],
    sourceReplies: [{ id: "request", authorAgentId: null, createdAt: "2026-10-26T10:59:50Z", body: "Hand this case to Riley for review with the findings you saved." }, { id: "reply", authorAgentId: "morgan", createdAt: "2026-10-26T11:00:30Z", createdByRunId: "source", body: "The review direction is queued for the primary task." }],
    caseRecord: { ...row, handoffVersion: 2 }, findings, findingVersions: [{ id: "original", issueId: "primary", body: findings.body, createdByAgentId: "morgan", createdByRunId: "stopped" }],
    handoffs: [{ id: "kickoff", version: 1 }, { id: "handoff", version: 2, issueId: "primary", actorType: "agent", actorId: "morgan", fromAgentId: "morgan", toAgentId: "riley", phase: "review", sourceRunId: "owner", commentId: "handoff-comment", instructions: findings.body, state: "completed", createdAt: "2026-10-26T11:01:30Z" }],
    reply: "The review direction is queued for the primary task." };
  return { ...base, state: { ...base.state, handoffCheckpoint: structuredClone(base) } };
}
describe("real Morgan same-primary review handoff", () => {
  it("source-qualifies an explicit self resume from a different chat execution without bypassing current-owner exclusion", () => {
    const request = { selfComment: true, resumeRequested: true, commentCreatedByRunId: "source-chat", issueAtCommentStart: { checkoutRunId: null, executionRunId: null }, reopened: false, currentStatus: "in_progress" };
    expect(shouldWakeAssigneeForIssueComment(request)).toBe(true);
    expect(shouldWakeAssigneeForIssueComment({ ...request, resumeRequested: false })).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...request, issueAtCommentStart: { executionRunId: "source-chat", checkoutRunId: null } })).toBe(false);
  });
  it("accepts genuine saved findings, actual primary continuation and eligible Riley review", () => {
    expect(gradeIntegratorCaseHandoff(valid()).passed).toBe(true); expect(gradeIntegratorCaseHandoff(undefined).passed).toBe(false);
    const natural = valid(); natural.handoffs[1]!.instructions = "Mobile Safari: touch on the checkout button produces no response. The keyboard works.";
    expect(gradeIntegratorCaseHandoff(natural).passed).toBe(true);
    const pointer = valid(); pointer.handoffs[1]!.instructions = "Review the saved investigation findings document `findings` on this same task (COM-1) against the customer observations in `brief`.";
    expect(gradeIntegratorCaseHandoff(pointer).passed).toBe(true);
    const empty = valid(); empty.handoffs[1]!.instructions = "Please review."; expect(gradeIntegratorCaseHandoff(empty).passed).toBe(false);
  });
  it("rejects CEO roleplay, a replacement primary, direct chat authority and missing original findings", () => {
    const ceo = valid(); ceo.actingAgent.name = "CEO"; ceo.actingAgent.role = "ceo"; expect(gradeIntegratorCaseHandoff(ceo).passed).toBe(false);
    const replacement = valid(); replacement.caseRecord.workIssueId = "new-primary"; expect(gradeIntegratorCaseHandoff(replacement).passed).toBe(false);
    const chat = valid(); chat.handoffs[1]!.sourceRunId = "source"; expect(gradeIntegratorCaseHandoff(chat).passed).toBe(false);
    const missing = valid(); missing.findingVersions = []; expect(gradeIntegratorCaseHandoff(missing).passed).toBe(false);
    const wrong = valid(); wrong.handoffs[1]!.instructions = "Mobile Safari tapping Pay works. Keyboard fails."; expect(gradeIntegratorCaseHandoff(wrong).passed).toBe(false);
    const negated = valid(); negated.handoffs[1]!.instructions = "On mobile Safari, tapping Pay does not fail. Keyboard activation works."; expect(gradeIntegratorCaseHandoff(negated).passed).toBe(false);
  });
  /** Retained paid run 43413553210: Morgan's answering chat run handed the released primary task straight to Riley. */
  function direct() {
    const o = valid();
    o.runs = o.runs.filter(run => run.id !== "owner");
    o.comments = [{ id: "handoff-comment", issueId: "primary", authorAgentId: "morgan", createdByRunId: "source" }];
    o.handoffs[1]!.sourceRunId = null as unknown as string; o.handoffs[1]!.state = "delivered";
    return o;
  }
  it("accepts the answering chat run handing off its own released primary task under ordinary owner authority", () => {
    const grade = gradeIntegratorCaseHandoff(direct());
    expect(grade.checks.filter(check => !check.passed)).toEqual([]);
  });
  it("rejects a handoff recorded by a stale, foreign or superseded execution, and extra unexplained runs", () => {
    const stale = direct(); stale.comments[0]!.createdByRunId = "stopped"; expect(gradeIntegratorCaseHandoff(stale).passed).toBe(false);
    const foreign = direct(); foreign.comments[0]!.authorAgentId = "riley"; expect(gradeIntegratorCaseHandoff(foreign).passed).toBe(false);
    const concurrent = direct(); concurrent.handoffs[1]!.sourceRunId = "other-execution"; expect(gradeIntegratorCaseHandoff(concurrent).passed).toBe(false);
    const early = direct(); early.runs[1]!.startedAt = "2026-10-26T10:59:00Z"; expect(gradeIntegratorCaseHandoff(early).passed).toBe(false);
    const unwoken = valid(); unwoken.runs[2]!.contextSnapshot = { issueId: "primary" }; expect(gradeIntegratorCaseHandoff(unwoken).passed).toBe(false);
    const extra = direct(); extra.runs.push({ id: "again", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "primary" }, runtimeMode: "native", startedAt: "2026-10-26T11:03:00Z" });
    expect(gradeIntegratorCaseHandoff(extra).passed).toBe(false);
    const twice = direct(); twice.runs.push({ id: "review-2", agentId: "riley", status: "succeeded", contextSnapshot: { issueId: "primary" }, runtimeMode: "native", startedAt: "2026-10-26T11:03:00Z" });
    expect(gradeIntegratorCaseHandoff(twice).passed).toBe(false);
  });
  it("bounds the ledger to the direct or routed run shape", async () => {
    const { gradeChatCatalogRuns } = await import("../chat-catalog-run-policy.js");
    const { integratorCaseHandoffCases } = await import("./integrator-case-handoff.js");
    const grade = (runs: ReturnType<typeof valid>["runs"]) => gradeChatCatalogRuns({ implementation: integratorCaseHandoffCases[0]!, companyId: "company", leadId: "morgan",
      source: { id: "chat" } as never, runs: runs.map(run => ({ ...run, companyId: "company" })) as never }).checks.every(check => check.passed);
    expect(grade(direct().runs)).toBe(true);
    expect(grade(valid().runs)).toBe(true);
    expect(grade(direct().runs.filter(run => run.id !== "review"))).toBe(false);
    expect(grade([...valid().runs, { id: "extra", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "primary" }, runtimeMode: "native", startedAt: "2026-10-26T11:04:00Z" }])).toBe(false);
  });
  it("rejects fictional delivery before the actual handoff and task-done-as-case-closed", () => {
    const early = valid(); early.state.handoffCheckpoint.reply = "I handed this case to Riley."; expect(gradeIntegratorCaseHandoff(early).passed).toBe(false);
    const closed = valid(); closed.caseRecord.status = "done"; expect(gradeIntegratorCaseHandoff(closed).passed).toBe(false);
    const wrongActor = valid(); wrongActor.handoffs[1]!.actorId = "ceo"; expect(gradeIntegratorCaseHandoff(wrongActor).passed).toBe(false);
  });
});

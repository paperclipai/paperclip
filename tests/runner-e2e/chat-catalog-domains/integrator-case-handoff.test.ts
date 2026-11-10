import { describe, expect, it } from "vitest";
import { gradeIntegratorCaseHandoff } from "./integrator-case-handoff.js";
import { shouldWakeAssigneeForIssueComment } from "../../../server/src/services/issue-comment-wakeup.js";
function valid() {
  const findings = { id: "findings", issueId: "primary", latestRevisionId: "original", body: "On mobile Safari, tapping Pay has no effect. Keyboard activation succeeds." };
  const row = { id: "case", workIssueId: "primary", handoffVersion: 1, status: "in_progress" };
  const runs = [{ id: "stopped", agentId: "morgan", status: "cancelled", contextSnapshot: { issueId: "primary" }, runtimeMode: "native", startedAt: "2026-10-26T10:00:00Z" },
    { id: "source", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "chat" }, runtimeMode: "native", startedAt: "2026-10-26T11:00:00Z" },
    { id: "owner", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "primary" }, runtimeMode: "native", startedAt: "2026-10-26T11:01:00Z" },
    { id: "review", agentId: "riley", status: "succeeded", contextSnapshot: { issueId: "primary" }, runtimeMode: "native", startedAt: "2026-10-26T11:02:00Z" }];
  const base = { scenarioId: "cases.handoff-same-task", origin: "https://fixture.test", companyId: "company", leadId: "morgan", state: { case: row, reviewer: { id: "riley" }, respondentId: "morgan", findings,
    interruptedRunId: "stopped", interruptedTask: { id: "primary", executionRunId: "stopped", assigneeAgentId: "morgan" } }, sourceIssueId: "chat", actingAgent: { id: "morgan", name: "Morgan", role: "engineer" }, reviewer: { id: "riley", name: "Riley", role: "engineer" },
    tasks: [{ id: "primary", assigneeAgentId: "riley", status: "done" }], projects: [], goals: [], documents: [], revisions: [], humanQueries: [], activity: [], links: [], runs,
    comments: [], sourceReplies: [{ id: "reply", authorAgentId: "morgan", createdAt: "2026-10-26T11:00:30Z", createdByRunId: "source", body: "The review direction is queued for the primary task." }],
    caseRecord: { ...row, handoffVersion: 2 }, findings, findingVersions: [{ id: "original", issueId: "primary", body: findings.body, createdByAgentId: "morgan", createdByRunId: "stopped" }],
    handoffs: [{ id: "kickoff", version: 1 }, { id: "handoff", version: 2, issueId: "primary", actorType: "agent", actorId: "morgan", fromAgentId: "morgan", toAgentId: "riley", phase: "review", sourceRunId: "owner", instructions: findings.body, state: "completed", createdAt: "2026-10-26T11:01:30Z" }],
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
  });
  it("rejects CEO roleplay, a replacement primary, direct chat authority and missing original findings", () => {
    const ceo = valid(); ceo.actingAgent.name = "CEO"; ceo.actingAgent.role = "ceo"; expect(gradeIntegratorCaseHandoff(ceo).passed).toBe(false);
    const replacement = valid(); replacement.caseRecord.workIssueId = "new-primary"; expect(gradeIntegratorCaseHandoff(replacement).passed).toBe(false);
    const chat = valid(); chat.handoffs[1]!.sourceRunId = "source"; expect(gradeIntegratorCaseHandoff(chat).passed).toBe(false);
    const missing = valid(); missing.findingVersions = []; expect(gradeIntegratorCaseHandoff(missing).passed).toBe(false);
    const wrong = valid(); wrong.handoffs[1]!.instructions = "Mobile Safari tapping Pay works. Keyboard fails."; expect(gradeIntegratorCaseHandoff(wrong).passed).toBe(false);
    const negated = valid(); negated.handoffs[1]!.instructions = "On mobile Safari, tapping Pay does not fail. Keyboard activation works."; expect(gradeIntegratorCaseHandoff(negated).passed).toBe(false);
  });
  it("rejects fictional delivery before the actual handoff and task-done-as-case-closed", () => {
    const early = valid(); early.state.handoffCheckpoint.reply = "I handed this case to Riley."; expect(gradeIntegratorCaseHandoff(early).passed).toBe(false);
    const closed = valid(); closed.caseRecord.status = "done"; expect(gradeIntegratorCaseHandoff(closed).passed).toBe(false);
    const wrongActor = valid(); wrongActor.handoffs[1]!.actorId = "ceo"; expect(gradeIntegratorCaseHandoff(wrongActor).passed).toBe(false);
  });
});

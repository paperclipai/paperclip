import { afterEach, expect, it, vi } from "vitest";
import { isNewHumanIntentAfterToolRejection } from "./tool-action-replay-intent.js";
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  return {
    session: { companyId: "company", issueId: "task", agentId: "agent", runId: "new-run", responsibleUserId: "person" },
    rejection: { companyId: "company", issueId: "task", status: "rejected", requestedByAgentId: "agent",
      resolvedByUserId: "person", decidedByUserId: "person", resolvedByAgentId: null, decidedByAgentId: null,
      resolvedAt: new Date(2_000), decidedAt: new Date(2_000) },
    invocation: { companyId: "company", issueId: "task", agentId: "agent", runId: "original-run" },
    run: { id: "new-run", companyId: "company", agentId: "agent", status: "running", responsibleUserId: "person", startedAt: new Date(4_000),
      issueId: "task", nativeIssueId: "task", contextSnapshot: { source: "issue.comment", issueId: "task", taskId: "task", commentId: "new-human" } },
    comment: { id: "new-human", companyId: "company", issueId: "task", authorType: "user", authorUserId: "person", authorAgentId: null, createdByRunId: null,
      derivedAuthorAgentId: null, derivedCreatedByRunId: null, derivedAuthorSource: null, deletedAt: null, sourceTrust: null, presentation: null,
      createdAt: new Date(3_000), body: "Please try that update again and let me review it." },
  } satisfies Parameters<typeof isNewHumanIntentAfterToolRejection>[0];
}
it("distinguishes a new authenticated human request after rejection without approving it", () => {
  const f = fixture(); expect(isNewHumanIntentAfterToolRejection(f)).toBe(true);
  expect(f.rejection.status).toBe("rejected");
});
it("accepts the ordinary direct-human reopen source with the same persisted intent checks", () => {
  const f = fixture(); f.run.contextSnapshot.source = "issue.comment.reopen";
  expect(isNewHumanIntentAfterToolRejection(f)).toBe(true);
});
it.each(["automatic", "derived", "forged comment"])("does not treat %s reopen input as a new human intent", fault => {
  const f = fixture(); f.run.contextSnapshot.source = "issue.comment.reopen";
  if (fault === "automatic") f.run.contextSnapshot.source = "automation.issue.comment.reopen";
  else if (fault === "derived") Object.assign(f.comment, { derivedCreatedByRunId: "agent-run" });
  else f.run.contextSnapshot.commentId = "unrelated-human-comment";
  expect(isNewHumanIntentAfterToolRejection(f)).toBe(false);
});
const invalid: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ["same intent retry", f => { f.comment.createdAt = new Date(1_000); }],
  ["same run retry", f => { f.invocation.runId = f.run.id; }],
  ["rejection continuation", f => { f.run.contextSnapshot.source = "tool_action_review"; }],
  ["automatic continuation", f => { f.run.contextSnapshot.source = "chat_task_completed"; }],
  ["foreign session company", f => { f.session.companyId = "foreign"; }],
  ["foreign request company", f => { f.rejection.companyId = "foreign"; }],
  ["foreign request task", f => { f.rejection.issueId = "foreign"; }],
  ["foreign invocation actor", f => { f.invocation.agentId = "foreign"; }],
  ["foreign invocation task", f => { f.invocation.issueId = "foreign"; }],
  ["foreign invocation company", f => { f.invocation.companyId = "foreign"; }],
  ["foreign run company", f => { f.run.companyId = "foreign"; }],
  ["foreign run actor", f => { f.run.agentId = "foreign"; }],
  ["stopped run", f => { f.run.status = "cancelled"; }],
  ["foreign context source", f => { f.run.contextSnapshot.issueId = "foreign"; }],
  ["contradictory task binding", f => { f.run.contextSnapshot.taskId = "foreign"; }],
  ["foreign native task", f => { f.run.nativeIssueId = "foreign"; }],
  ["foreign stored run task", f => { f.run.issueId = "foreign"; }],
  ["wrong canonical comment", f => { f.run.contextSnapshot.commentId = "old-human"; }],
  ["foreign comment task", f => { f.comment.issueId = "foreign"; }],
  ["foreign comment company", f => { f.comment.companyId = "foreign"; }],
  ["another human", f => { f.comment.authorUserId = "another-person"; }],
  ["wrong responsible user", f => { f.run.responsibleUserId = "another-person"; }],
  ["another person's rejection", f => { f.rejection.decidedByUserId = "another-person"; }],
  ["unknown rejection author", f => { f.rejection.decidedByUserId = ""; f.rejection.resolvedByUserId = ""; }],
  ["agent-attributed comment", f => { Object.assign(f.comment, { authorAgentId: "agent" }); }],
  ["agent-created comment", f => { Object.assign(f.comment, { createdByRunId: "old-run" }); }],
  ["derived agent comment", f => { Object.assign(f.comment, { derivedAuthorAgentId: "agent" }); }],
  ["derived run comment", f => { Object.assign(f.comment, { derivedCreatedByRunId: "run" }); }],
  ["derived attribution", f => { Object.assign(f.comment, { derivedAuthorSource: "run_log" }); }],
  ["deleted human comment", f => { Object.assign(f.comment, { deletedAt: new Date(5_000) }); }],
  ["untrusted external source", f => { Object.assign(f.comment, { sourceTrust: { disposition: "quarantined" } }); }],
  ["system notice", f => { Object.assign(f.comment, { presentation: { kind: "system_notice" } }); }],
  ["non-user author", f => { f.comment.authorType = "agent"; }],
  ["empty comment", f => { f.comment.body = " "; }],
  ["new-session command", f => { f.comment.body = "/new"; }],
  ["equal rejection time", f => { f.comment.createdAt = new Date(2_000); }],
  ["comment after run started", f => { f.comment.createdAt = new Date(5_000); }],
  ["future run", f => { f.run.startedAt = new Date(11_000); }],
  ["invalid decision time", f => { f.rejection.decidedAt = new Date(NaN); }],
  ["invalid comment time", f => { f.comment.createdAt = new Date(NaN); }],
  ["invalid start time", f => { f.run.startedAt = new Date(NaN); }],
];
it.each(invalid)("preserves the prior rejection for %s", (_name, mutate) => {
  const f = fixture(); mutate(f); expect(isNewHumanIntentAfterToolRejection(f)).toBe(false);
});
it.each(["pending", "approved", "executing", "executed", "failed", "cancelled"])("never bypasses %s action state", status => {
  const f = fixture(); f.rejection.status = status; expect(isNewHumanIntentAfterToolRejection(f)).toBe(false);
});

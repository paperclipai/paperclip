import { describe, expect, it } from "vitest";
import { completionJourneyChecks, type CompletionScope } from "./completion-delivery-evidence.js";
import type { CompletionObservation } from "../completion-updates.js";

function fixture() {
  const scope: CompletionScope = { companyId: "company", sourceId: "source", userId: "user", leadId: "lead", workerAgentId: "worker",
    projectId: "project", taskTitle: "Brief campaign", provider: "opencode", model: "configured", environmentId: "daytona" };
  const expectedBody = "Reference: completion-campaign\nVerify the release with the smoke suite. Roll back the release if the smoke suite fails.";
  const native = { companyId: scope.companyId, status: "succeeded", runtimeMode: "native", runnerProfileJson: { nativeExecutionInput: { provider: { kind: scope.provider, model: scope.model } } } };
  const environment = { paperclipEnvironment: { id: scope.environmentId } };
  const runs = [{ ...native, id: "request-run", agentId: "lead", issueId: "source", contextSnapshot: { ...environment, issueId: "source", source: "issue.comment", wakeCommentId: "request" } },
    { ...native, id: "worker-run", agentId: "worker", issueId: "task", contextSnapshot: { ...environment, issueId: "task" } },
    { ...native, id: "callback-run", agentId: "lead", issueId: "source", invocationSource: "automation", triggerDetail: "system", contextSnapshot: {
      ...environment, issueId: "source", wakeReason: "chat_task_completed", wakeSource: "automation", wakeTriggerDetail: "system",
      chatCompletionDeliveryIds: ["delivery"], chatCompletionUpdates: [{ id: "task", status: "done" }] } }];
  const observation: CompletionObservation = { sourceId: "source", marker: "completion-campaign",
    worker: { id: "task", identifier: "QA-1", companyId: "company", projectId: "project", title: scope.taskTitle, createdByAgentId: "lead",
      assigneeAgentId: "worker", status: "done", completedAt: "2020-01-01T00:00:01Z" }, runs,
    documents: [{ id: "document", companyId: "company", issueId: "task", key: "completion-brief", body: expectedBody, latestRevisionId: "revision" }],
    comments: [{ id: "request", companyId: "company", issueId: "source", authorUserId: "user", body: "Please delegate this brief." },
      { id: "reply", companyId: "company", issueId: "source", authorAgentId: "lead", createdByRunId: "callback-run", createdAt: "2020-01-01T00:00:02Z", body: "The brief is ready: [completed brief](/QA/issues/QA-1)." }],
    renderedLinks: [{ commentId: "reply", href: "/QA/issues/QA-1" }] };
  const input = { request: "Please delegate this brief.", expectedBody,
    revisions: [{ id: "revision", createdByAgentId: "worker", createdByRunId: "worker-run", body: expectedBody }],
    events: [{ id: "event", companyId: "company", actorType: "agent", actorId: "lead", agentId: "lead", entityType: "issue", entityId: "task", action: "issue.created", details: { assigneeAgentId: "worker", assigneeUserId: null }, runId: "request-run" }] };
  return { scope, observation, input };
}
const grade = (f: ReturnType<typeof fixture>) => completionJourneyChecks(f.scope, f.observation, f.input);
describe("completion journey independently proves delivery", () => {
  it("accepts a saved worker-authored output and server-correlated reply after one request", () => expect(grade(fixture()).every(check => check.passed)).toBe(true));
  it("rejects a late initial promise even when it links to the completed task", () => {
    const f = fixture(); f.observation.comments[1]!.createdByRunId = "request-run";
    expect(grade(f).find(check => check.id === "completion-source-correlated")?.passed).toBe(false);
    expect(grade(f).find(check => check.id === "completion-result-access")?.passed).toBe(false);
  });
  it.each(["worker-output", "missing-output", "wrong-source-comment", "revision", "callback-facts", "link", "native", "model", "environment", "creation-audit", "initial-assignment", "assignment", "user-prompt", "extra-run"])("rejects missing or wrong %s", fault => {
    const f = fixture();
    if (fault === "worker-output") f.observation.documents[0]!.body = "Reference: completion-campaign. I will write the brief later.";
    if (fault === "missing-output") f.observation.documents = [];
    if (fault === "wrong-source-comment") f.observation.comments[1]!.companyId = "other";
    if (fault === "revision") f.input.revisions[0]!.createdByAgentId = "lead";
    if (fault === "callback-facts") f.observation.runs[2]!.contextSnapshot.chatCompletionUpdates[0].id = "foreign";
    if (fault === "link") f.observation.renderedLinks = [];
    if (fault === "native") f.observation.runs[1]!.runtimeMode = "legacy";
    if (fault === "model") f.observation.runs[1]!.runnerProfileJson = { nativeExecutionInput: { provider: { kind: "opencode", model: "other" } } };
    if (fault === "environment") f.observation.runs[1]!.contextSnapshot.paperclipEnvironment.id = "other";
    if (fault === "creation-audit") f.input.events = [];
    if (fault === "initial-assignment") f.input.events[0]!.details.assigneeAgentId = "lead";
    if (fault === "assignment") f.observation.worker.assigneeAgentId = "lead";
    if (fault === "user-prompt") f.observation.comments.push({ ...f.observation.comments[0], id: "extra-request" });
    if (fault === "extra-run") f.observation.runs.push({ ...f.observation.runs[2], id: "extra-run" });
    expect(grade(f).some(check => !check.passed)).toBe(true);
  });
  it("does not accept a marker as a quoted deliverable", () => {
    const f = fixture(); f.observation.renderedLinks = []; f.observation.comments[1]!.body = "Done: completion-campaign";
    expect(grade(f).find(check => check.id === "completion-result-access")?.passed).toBe(false);
  });
});

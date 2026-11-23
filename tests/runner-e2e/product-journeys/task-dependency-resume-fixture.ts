import type { DependencyEvidence, DependencyPoint } from "./task-dependency-resume-evidence.js";

export function dependencyEvidenceFixture(): DependencyEvidence {
  const start = Date.parse("2020-01-01T00:00:00.000Z");
  const scope = { companyId: "company", userId: "user", agentId: "agent", environmentId: "environment", provider: "opencode", model: "fixture-model",
    blockerId: "blocker", blockerIdentifier: "QA-1", blockerTitle: "Review gate", blockerDescription: "The review reference is secret-reference.",
    dependentId: "dependent", dependentTitle: "Continue after review", prompt: "Read QA-1 after its review and write dependency-proof.", reference: "secret-reference", documentKey: "dependency-proof" };
  const point = (observedAt: number): DependencyPoint => ({ observedAt,
    blocker: { id: scope.blockerId, identifier: scope.blockerIdentifier, companyId: scope.companyId, title: scope.blockerTitle,
      description: scope.blockerDescription, status: "todo", createdByUserId: scope.userId, createdByAgentId: null,
      assigneeUserId: scope.userId, assigneeAgentId: null },
    dependent: { id: scope.dependentId, identifier: "QA-2", companyId: scope.companyId, title: scope.dependentTitle,
      description: scope.prompt, status: "blocked", createdByUserId: scope.userId, createdByAgentId: null,
      assigneeUserId: null, assigneeAgentId: scope.agentId, blockedByIssueIds: [scope.blockerId], executionRunId: null, checkoutRunId: null },
    blockerRuns: [], dependentRuns: [], agentRuns: [], activity: [], activityCoverage: { blocker: true, dependent: true, agent: true } });
  const created = point(start);
  Object.assign(created.dependent, { status: "todo", assigneeAgentId: null, assigneeUserId: scope.userId, blockedByIssueIds: [] });
  const released = point(start + 20_000); Object.assign(released.blocker, { status: "done", completedAt: "2020-01-01T00:00:20.000Z" });
  const run = { id: "run", companyId: scope.companyId, agentId: scope.agentId, nativeIssueId: scope.dependentId,
    status: "succeeded", runtimeMode: "native", nativePhase: "committed", invocationSource: "automation", triggerDetail: "system",
    startedAt: "2020-01-01T00:00:21.000Z",
    contextSnapshot: { issueId: scope.dependentId, taskId: scope.dependentId, wakeReason: "issue_blockers_resolved", source: "issue.blockers_resolved",
      resolvedBlockerIssueId: scope.blockerId, blockerIssueIds: [scope.blockerId], paperclipEnvironment: { id: scope.environmentId } },
    runnerProfileJson: { nativeExecutionInput: { provider: { kind: scope.provider, model: scope.model } } } };
  const document = { id: "document", companyId: scope.companyId, issueId: scope.dependentId, key: scope.documentKey,
    body: JSON.stringify({ reference: scope.reference, blockerIdentifier: scope.blockerIdentifier }), latestRevisionId: "revision",
    createdByAgentId: scope.agentId, createdByUserId: null };
  const revision = { id: "revision", documentId: document.id, body: document.body, createdByAgentId: scope.agentId,
    createdByUserId: null, createdByRunId: run.id };
  const finished = structuredClone(released); finished.observedAt = start + 30_000; finished.dependent.status = "done";
  finished.dependentRuns = [structuredClone(run)]; finished.agentRuns = [structuredClone(run)];
  finished.document = document; finished.revision = revision;
  const reopened = structuredClone(finished); reopened.observedAt = start + 31_000; reopened.resultVisible = true;
  reopened.activity = [{ id: "completion", companyId: scope.companyId, actorType: "user", actorId: scope.userId,
    action: "issue.updated", entityType: "issue", entityId: scope.blockerId, details: { status: "done" } }];
  return { scope, startingAgentRuns: [], created, waiting: [point(start + 1_000), point(start + 11_000)], releaseRequestedAt: start + 19_000,
    released, finished, reopened };
}

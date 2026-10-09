import { createHash } from "node:crypto";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

/** Credential-free semantic input shared by actual adapter-boundary tests. */
export function createPromptContextFixture() {
  const description = "Keep this deliberate repetition. Keep this deliberate repetition.";
  const revision = createHash("sha256").update(description).digest("hex");
  const messages = [
    { id: "comment-first", body: "Append the same ledger entry." },
    { id: "comment-second", body: "Append the same ledger entry." },
    { id: "comment-scope", body: "Change the final scope to the launch checklist." },
  ].map((message) => ({
    ...message,
    authorType: "user" as const,
    authorId: "user-1",
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    deleted: false,
    sourceTrust: "human" as const,
  }));
  const executionContinuation: ExecutionContinuationEnvelope = {
    version: 1,
    companyId: "company-1",
    issueId: "issue-1",
    trigger: { reason: "issue_commented", interactionId: null, sourceRunId: null },
    originCommentIds: messages.map(({ id }) => id),
    objective: description,
    objectiveSource: { kind: "description", id: "issue-1", revision },
    messages,
    resumeDelta: { baseRunId: "prior-run", messages: messages.slice(1) },
    interactionOutcomes: [],
    completedWork: null,
    completedActions: [{ runId: "prior-run", receiptId: "receipt-1", operationId: "published-action", result: { published: true } }],
    unresolvedInteractionIds: [],
    coverage: { kind: "full_task_history", throughCommentId: "comment-scope", summaryThroughCommentId: null },
  };
  return {
    paperclipTaskMarkdownAssignment: `## Owned assignment\n\n${description}\n\nPlan revision: approved-revision-2`,
    paperclipTaskMarkdownAssignmentCompact: "## Compact assignment\n\nPlan revision: approved-revision-2",
    paperclipTaskCommunicationGuidance: "Explain the next step before starting work.",
    paperclipTurnContext: {
      version: 1,
      assignment: { owner: "task_markdown", description: { id: "issue-1", revision } },
      events: { owner: "wake_prompt", comments: messages.map(({ id, updatedAt }) => ({ id, revision: updatedAt })) },
    },
    executionContinuation,
    paperclipWake: {
      reason: "issue_commented",
      issue: { id: "issue-1", identifier: "PAP-1", title: "Release ledger", description, status: "in_progress", workMode: "standard" },
      comments: messages,
      commentWindow: { requestedCount: 3, includedCount: 3, missingCount: 0 },
      fallbackFetchNeeded: false,
      executionContinuation,
    },
  };
}

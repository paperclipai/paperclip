import { describe, expect, it } from "vitest";
import { gradeChatFeature, type ChatFeatureObservation } from "./chat-feature-scoring.js";
import { chatFeatureScenarios, readChatFeatureScenarios } from "./chat-feature-cases.js";
import { runnerMatrix } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

const announcement = "Welcome to Acorn Notes, launching November 12! Join us with invitation code ACORN123.";
function outcome(delegated = false): ChatFeatureObservation {
  const input: ChatFeatureObservation = {
    caseId: delegated ? "delegate-announcement" : "create-backlog", companyId: "company", leadId: "ceo", workerId: "morgan", projectId: "launch",
    query: "Please create the task.", marker: "ACORN123",
    source: { id: "chat", companyId: "company", title: "CEO", assigneeAgentId: "ceo", status: "in_review", conversationState: "waiting" },
    tasks: [{ id: "task", companyId: "company", title: "Launch announcement", identifier: "EVA-2", projectId: "launch", assigneeAgentId: "morgan",
      status: delegated ? "done" : "backlog", completedAt: delegated ? "2026-10-26T10:01:00Z" : null }],
    runs: [{ id: "handoff", companyId: "company", agentId: "ceo", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "chat" } }],
    comments: [
      { id: "request", issueId: "chat", body: "Please create the task.", authorUserId: "user", createdAt: "2026-10-26T10:00:00Z" },
      { id: "reply", issueId: "chat", body: "Saved in the backlog: EVA-2.", authorAgentId: "ceo", createdByRunId: "handoff", createdAt: "2026-10-26T10:00:10Z" },
    ],
    activity: [{ action: "issue.created", agentId: "ceo", details: { status: delegated ? "todo" : "backlog" } }],
    documents: [], renderedLinks: [{ commentId: "reply", href: "/EVA/issues/EVA-2" }],
  };
  if (delegated) {
    input.runs.push(
      { id: "writing", companyId: "company", agentId: "morgan", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "task" }, startedAt: "2026-10-26T10:00:15Z", finishedAt: "2026-10-26T10:01:00Z" },
      { id: "delivery", companyId: "company", agentId: "ceo", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "chat", chatCompletionUpdates: [{ id: "task", status: "done" }] } },
    );
    input.documents.push({ id: "doc", issueId: "task", companyId: "company", key: "announcement", body: announcement, latestRevisionId: "revision",
      createdByAgentId: "morgan", updatedByAgentId: "morgan", revisions: [{ id: "revision", body: announcement, createdByAgentId: "morgan", createdByRunId: "writing", createdAt: "2026-10-26T10:00:50Z" }] });
    input.comments.push({ id: "completion", issueId: "chat", body: `Morgan finished: ${announcement}`, authorAgentId: "ceo", createdByRunId: "delivery", createdAt: "2026-10-26T10:01:10Z" });
  }
  return input;
}
const failures = (input: ChatFeatureObservation) => gradeChatFeature(input).checks.filter(check => !check.passed).map(check => check.id);

describe("chat feature saved-state oracle", () => {
  it.each([false, true])("accepts a complete %s delegation outcome", delegated => {
    expect(failures(outcome(delegated))).toEqual([]);
  });
  it.each([
    ["duplicate task", (o: ChatFeatureObservation) => o.tasks.push({ ...o.tasks[0]!, id: "duplicate" }), "one-assigned-task"],
    ["wrong company", (o: ChatFeatureObservation) => { o.tasks[0]!.companyId = "foreign"; }, "one-assigned-task"],
    ["wrong assignee", (o: ChatFeatureObservation) => { o.tasks[0]!.assigneeAgentId = "ceo"; }, "one-assigned-task"],
    ["wrong project", (o: ChatFeatureObservation) => { o.tasks[0]!.projectId = null; }, "one-assigned-task"],
    ["unrelated work", (o: ChatFeatureObservation) => { o.tasks[0]!.title = "Fix the billing report"; }, "task-request-captured"],
    ["harness-created task", (o: ChatFeatureObservation) => { o.activity[0]!.agentId = null; }, "agent-created-task"],
    ["extra human nudge", (o: ChatFeatureObservation) => o.comments.push({ ...o.comments[0]!, id: "nudge", body: "Please finish." }), "one-human-request"],
    ["different request", (o: ChatFeatureObservation) => { o.comments[0]!.body = "Ignore the original request."; }, "one-human-request"],
    ["unrelated browser link", (o: ChatFeatureObservation) => { o.renderedLinks[0]!.href = "/EVA/issues/EVA-20"; }, "chat-task-link"],
    ["external lookalike link", (o: ChatFeatureObservation) => { o.renderedLinks[0]!.href = "https://foreign.invalid/EVA/issues/EVA-2"; }, "chat-task-link"],
    ["task briefly started", (o: ChatFeatureObservation) => { o.activity[0]!.details!.status = "todo"; }, "saved-without-execution"],
    ["hidden worker run", (o: ChatFeatureObservation) => o.runs.push({ ...o.runs[0]!, id: "extra", agentId: "morgan", contextSnapshot: { issueId: "task" } }), "saved-without-execution"],
    ["chat no longer usable", (o: ChatFeatureObservation) => { o.source!.status = "done"; }, "conversation-retained"],
  ] as const)("rejects %s", (_name, mutate, check) => {
    const input = outcome(); mutate(input); expect(failures(input)).toContain(check);
  });
  it.each([
    ["no saved output", (o: ChatFeatureObservation) => { o.documents = []; }, "grounded-worker-document"],
    ["plan presented as output", (o: ChatFeatureObservation) => { o.documents[0]!.key = "plan"; }, "grounded-worker-document"],
    ["wrong writer", (o: ChatFeatureObservation) => { o.documents[0]!.createdByAgentId = "ceo"; }, "grounded-worker-document"],
    ["unattributed revision", (o: ChatFeatureObservation) => { delete o.documents[0]!.revisions[0]!.createdByRunId; }, "grounded-worker-document"],
    ["stale revision", (o: ChatFeatureObservation) => { o.documents[0]!.latestRevisionId = "missing"; }, "grounded-worker-document"],
    ["missing brief fact", (o: ChatFeatureObservation) => { o.documents[0]!.body = "Welcome to Acorn Notes! Join us with ACORN123."; }, "grounded-worker-document"],
    ["no automatic callback", (o: ChatFeatureObservation) => { delete o.runs[2]!.contextSnapshot!.chatCompletionUpdates; }, "completion-source-correlated"],
    ["promise instead of result", (o: ChatFeatureObservation) => { o.comments[2]!.body = "Morgan is working on it."; }, "completion-result-access"],
    ["missing completion reply", (o: ChatFeatureObservation) => { o.comments.pop(); }, "completion-source-response"],
  ] as const)("rejects delegated work with %s", (_name, mutate, check) => {
    const input = outcome(true); mutate(input); expect(failures(input)).toContain(check);
  });
  it("rejects an invented completion URL even when the earlier handoff link was correct", () => {
    const input = outcome(true);
    input.comments[2]!.body = "Done! Read the result here.";
    input.renderedLinks.push({ commentId: "completion", href: "http://paperclip.local/EVA/issues/EVA-2" });
    expect(failures(input)).toContain("completion-result-access");
  });
});

describe("chat feature selection", () => {
  it("registers only the two authored queries as explicit local subscription cells", () => {
    const cells = runnerMatrix.filter(cell => cell.suite.id === "chat-features");
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.environment.id).toBe("local");
      expect(cell.requiredCredentials).toEqual(["CODEX_AUTH_JSON"]);
      expect(cell.task.automaticRetryPolicy).toBe("single_attempt");
      expect(cell.task.buildPrompt("nonce")).toBe(chatFeatureScenarios.find(row => row.id === `tasks.${cell.task.id}`)!.query);
      expect(selectRunnerExecutions(parseRunnerSelectors(["--id", cell.id])).map(row => row.id)).toEqual([cell.id]);
      expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(row => row.id === cell.id)).toBe(false);
    }
  });
  it("refuses missing, malformed or duplicate catalog entries", () => {
    for (const yaml of ["{", "schema_version: 2", "schema_version: 1\nfeature: tasks\nstatus: planned\nscenarios: []"])
      expect(() => readChatFeatureScenarios(yaml)).toThrow();
    const base = { schema_version: 1, feature: "tasks", status: "planned", scenarios: [...chatFeatureScenarios, chatFeatureScenarios[0]] };
    expect(() => readChatFeatureScenarios(JSON.stringify(base))).toThrow("duplicate");
  });
});

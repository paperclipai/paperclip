import { describe, expect, it } from "vitest";
import { assertChatFlowRunCount } from "./chat-flow.js";
import { needsChatCompletionProof, verifyChatCompletion } from "./chat-completion-proof.js";

// Shape and ordering from run 41915965118's three retained failing journeys.
// The ordinary turns keep their existing bound; the one real completion turn
// must prove its own child, delivery, native tools, reply and rendered link.
function completionRecording(id = "multi-repository", expectedRunCount = 2) {
  const companyId = "company", agentId = "agent", sourceId = "chat", childId = "child";
  const completedAt = "2026-11-04T21:35:52.000Z";
  const issue = { id: sourceId, companyId, conversationAgentId: agentId, conversationSessionGeneration: 0 };
  const child = { id: childId, companyId, assigneeAgentId: agentId, status: "done", completedAt, identifier: "RUN-2" };
  const ordinary = Array.from({ length: expectedRunCount }, (_, index) => ({
    id: `ordinary-${index}`, companyId, agentId, status: "succeeded", runtimeMode: "native",
    issueId: index === expectedRunCount - 1 ? childId : sourceId, nativeIssueId: index === expectedRunCount - 1 ? childId : sourceId,
    contextSnapshot: { issueId: index === expectedRunCount - 1 ? childId : sourceId },
    startedAt: "2026-11-04T21:35:00.000Z", processStartedAt: "2026-11-04T21:35:01.000Z",
    finishedAt: "2026-11-04T21:35:51.000Z",
    nativeSessionId: `native-${index}`, usageJson: { accountingReceiptReady: true, outputTokens: 10 },
  }));
  const notification = {
    id: "notification", companyId, agentId, issueId: sourceId, nativeIssueId: sourceId,
    status: "succeeded", runtimeMode: "native", invocationSource: "automation", triggerDetail: "system",
    startedAt: "2026-11-04T21:35:53.000Z", processStartedAt: "2026-11-04T21:35:54.000Z",
    finishedAt: "2026-11-04T21:36:15.000Z", nativeSessionId: "native-chat-session",
    contextSnapshot: { issueId: sourceId, wakeReason: "chat_task_completed", wakeSource: "automation",
      conversationSessionGeneration: 0, chatCompletionDeliveryIds: ["delivery"],
      chatCompletionUpdates: [{ id: childId, status: "done", completedAt, identifier: "RUN-2", url: "/issues/RUN-2" }] },
    usageJson: { inputTokens: 40_178, outputTokens: 2071, cachedInputTokens: 222_147,
      costUsdExact: "0.290990800", costStatus: "estimated", accountingReceiptReady: true },
  };
  const comments = [{ id: "reply", companyId, issueId: sourceId, authorAgentId: agentId, authorType: "agent",
    createdByRunId: notification.id, conversationSessionGeneration: 0,
    createdAt: "2026-11-04T21:36:15.100Z", deletedAt: null,
    body: "[RUN-2](/issues/RUN-2) is complete. Its requested document is saved on the task." }];
  const events = ["tool.execution.started", "tool.execution.completed", "run.result.accepted"].map((eventType, index) => ({
    companyId, runId: notification.id, agentId, eventType,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", runId: notification.id, eventType,
      payload: eventType.startsWith("tool.") ? { schema: "paperclip.tool.execution.v1", name: "paperclip_finish",
        executionId: "finish", status: index === 0 ? "running" : "completed" } : {} } },
  }));
  const runs = [...ordinary, notification];
  return { suiteId: "agent-chat", profileId: "runner-codex", environmentId: "local", notification,
    task: { id, expectedRunCount }, runs,
    completionEvidence: { companyId, agentId, companyPrefix: "RUN", baseURL: "http://fixture.invalid", issue, child,
      tasks: [child], comments, runEvidence: [{ runId: notification.id, events,
        workspaceOperations: [] as Array<Record<string, unknown>> }],
      renderedLinks: [{ commentId: "reply", href: "/RUN/issues/RUN-2" }] } };
}

describe("delegated chat completion provider accounting", () => {
  for (const [id, bound] of [["multi-repository", 2], ["clarify-reuse", 3], ["plan-handoff", 4]] as const) {
    it(`accounts for the required verified notification after ${id}`, () => {
      const input = completionRecording(id, bound);
      const original = JSON.stringify(input);
      expect(() => assertChatFlowRunCount(input)).not.toThrow();
      expect(verifyChatCompletion(input.runs, input.completionEvidence)).toMatchObject({ ordinaryProviderRuns: bound,
        totalProviderRuns: bound + 1, allRunIds: input.runs.map(r => r.id), notificationRunId: input.notification.id });
      expect(input.runs).toHaveLength(bound + 1);
      expect(input.runs.at(-1)?.usageJson?.outputTokens).toBe(2071);
      expect(JSON.stringify(input)).toBe(original);
    });
  }

  const invalid: Array<[string, (input: ReturnType<typeof completionRecording>) => void]> = [
    ["missing required notification", f => { f.runs.pop(); }],
    ["duplicate paid notification", f => { f.runs.push({ ...f.notification, id: "duplicate" }); }],
    ["wrong source company", f => { f.completionEvidence.issue.companyId = "other-company"; }],
    ["wrong child company", f => { f.completionEvidence.child.companyId = "other-company"; }],
    ["cross-scope notification", f => { f.notification.companyId = "other-company"; }],
    ["old conversation generation", f => { f.notification.contextSnapshot.conversationSessionGeneration = 1; }],
    ["unknown automatic work", f => { f.notification.contextSnapshot.wakeReason = "unrelated_automation"; }],
    ["two delivery receipts", f => { f.notification.contextSnapshot.chatCompletionDeliveryIds.push("other-delivery"); }],
    ["wrong completed child", f => { f.notification.contextSnapshot.chatCompletionUpdates[0]!.id = "other-child"; }],
    ["unfinished child", f => { f.completionEvidence.child.status = "in_review"; }],
    ["never-started native work", f => { f.notification.processStartedAt = ""; }],
    ["missing actual native completion", f => { f.notification.finishedAt = ""; }],
    ["unaccounted provider work", f => { f.notification.usageJson.accountingReceiptReady = false; }],
    ["missing intended reply", f => { f.completionEvidence.comments.length = 0; }],
    ["duplicate completion replies", f => { f.completionEvidence.comments.push({ ...f.completionEvidence.comments[0]!, id: "other-reply" }); }],
    ["deleted reply", f => { Object.assign(f.completionEvidence.comments[0]!, { deletedAt: "2026-11-04T21:36:16Z" }); }],
    ["cross-generation reply", f => { f.completionEvidence.comments[0]!.conversationSessionGeneration = 1; }],
    ["missing rendered result access", f => { f.completionEvidence.renderedLinks.length = 0; }],
    ["foreign-origin task link", f => { f.completionEvidence.renderedLinks[0]!.href = "https://other.invalid/RUN/issues/RUN-2"; }],
    ["foreign-company task route", f => { f.completionEvidence.renderedLinks[0]!.href = "/OTHER/issues/RUN-2"; }],
    ["extra delegated work", f => { f.completionEvidence.tasks.push({ ...f.completionEvidence.child, id: "extra-child" }); }],
    ["missing native result stream", f => { f.completionEvidence.runEvidence[0]!.events.length = 0; }],
    ["cross-scope native events", f => { f.completionEvidence.runEvidence[0]!.events[0]!.companyId = "other-company"; }],
    ["accepted result for another native run", f => { f.completionEvidence.runEvidence[0]!.events[2]!.payload.prpEvent.runId = "other-run"; }],
    ["unfinished native tool", f => { f.completionEvidence.runEvidence[0]!.events.splice(1, 1); }],
    ["tool completion before execution", f => { f.completionEvidence.runEvidence[0]!.events.reverse(); }],
    ["missing workspace observation", f => { Object.assign(f.completionEvidence.runEvidence[0]!, { workspaceOperations: undefined }); }],
    ["new task tool inside a notification", f => {
      for (const e of f.completionEvidence.runEvidence[0]!.events.slice(0, 2)) e.payload.prpEvent.payload.name = "create_task";
    }],
    ["additional workspace command", f => { f.completionEvidence.runEvidence[0]!.workspaceOperations.push({
      companyId: "company", heartbeatRunId: "notification", phase: "command", status: "succeeded", command: "unexpected work" }); }],
  ];
  for (const [name, mutate] of invalid) it(`rejects ${name}`, () => {
    const input = completionRecording(); mutate(input);
    expect(() => assertChatFlowRunCount(input)).toThrow(/Chat completion proof:/);
  });

  it("keeps the existing ordinary-turn count exact", () => {
    const missing = completionRecording(); missing.runs.splice(0, 1);
    expect(() => assertChatFlowRunCount(missing)).toThrow(/Declared ordinary provider-run bounds/);
    const extra = completionRecording(); extra.runs.splice(0, 0, { ...extra.runs[0]!, id: "extra-ordinary" });
    expect(() => assertChatFlowRunCount(extra)).toThrow(/Declared ordinary provider-run bounds/);
  });

  it("keeps every other case, profile and environment on its original total bound", () => {
    for (const patch of [{ task: { id: "create-backlog", expectedRunCount: 2 } },
      { profileId: "runner-opencode" }, { environmentId: "daytona" }, { suiteId: "other-suite" }]) {
      const input = { ...completionRecording(), ...patch };
      expect(() => assertChatFlowRunCount(input)).toThrow(/Declared total provider-run bounds/);
    }
    expect(needsChatCompletionProof("agent-chat", undefined, "runner-codex", "local")).toBe(false);
  });
});

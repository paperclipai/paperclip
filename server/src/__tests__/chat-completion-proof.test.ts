import { describe, expect, it, vi } from "vitest";
import { assertChatFlowRunCount, collectChatRunEvidence, retryChatCompletionObservation } from "../../../tests/runner-e2e/chat-flow.js";
import { needsChatCompletionProof, verifyChatCompletion, type ChatCompletionEvidence } from "../../../tests/runner-e2e/chat-completion-proof.js";
import { pollUntil } from "../../../tests/runner-e2e/api.js";

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
  const events: ChatCompletionEvidence["runEvidence"][number]["events"] = ["tool.execution.started", "tool.execution.completed", "run.result.accepted"].map((eventType, index) => ({
    companyId, runId: notification.id, agentId, eventType, seq: index + 1,
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
  it("reports a permanent completion proof failure without retrying to the idle deadline", async () => {
    vi.useFakeTimers();
    try {
      const input = completionRecording();
      input.completionEvidence.tasks.push({ ...input.completionEvidence.child, id: "extra-child" });
      const load = vi.fn(async () => verifyChatCompletion(input.runs, input.completionEvidence));
      const outcome = pollUntil({ label: "chat turn settles to waiting", deadlineAt: Date.now() + 240_000,
        intervalMs: 1000, load, accept: Boolean, retryOnError: retryChatCompletionObservation })
        .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      await vi.advanceTimersByTimeAsync(240_000);
      expect((await outcome).error?.message).toBe("Chat completion proof: extra_work");
      expect(load).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("still retries a transient observation error within the original idle deadline", async () => {
    vi.useFakeTimers();
    try {
      const input = completionRecording();
      const load = vi.fn(async () => verifyChatCompletion(input.runs, input.completionEvidence));
      load.mockRejectedValueOnce(new Error("temporary API observation failure"));
      const outcome = pollUntil({ label: "chat turn settles to waiting", deadlineAt: Date.now() + 240_000,
        intervalMs: 1000, load, accept: Boolean, retryOnError: retryChatCompletionObservation });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await outcome).toMatchObject({ ordinaryProviderRuns: 2, totalProviderRuns: 3 });
      expect(load).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("collects the live run API evidence before proving a completion", async () => {
    const input = completionRecording();
    const recorded = input.completionEvidence.runEvidence[0]!;
    const native = (eventType: string, payload: Record<string, unknown>) => ({ companyId: "company", agentId: "agent",
      runId: input.notification.id, eventType,
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", runId: input.notification.id, eventType, payload } } });
    // The native item/tool shapes come from the retained completion stream.
    // Use the actual collector, including its complete paged-event read.
    recorded.events = [
      native("item.completed", { kind: "model", model: "gpt-5.6-sol" }),
      native("item.completed", { kind: "reasoning", item: { type: "reasoning" } }),
      native("item.started", { kind: "dynamicToolCall", item: { type: "tool_use", id: "read", name: "get_task" } }),
      native("tool.execution.started", { schema: "paperclip.tool.execution.v1", name: "get_task", executionId: "read", status: "running" }),
      native("item.completed", { kind: "dynamicToolCall", item: { type: "tool_result", id: "read", tool_use_id: "read" } }),
      native("tool.execution.completed", { schema: "paperclip.tool.execution.v1", name: "get_task", executionId: "read", status: "completed" }),
      native("item.completed", { kind: "agentMessage", item: { type: "agentMessage" } }),
      ...recorded.events,
      native("item.completed", { kind: "usage", usage: input.notification.usageJson }),
    ].map((event, index) => ({ ...event, seq: index + 1 }));
    const workspaceOperations = [{ companyId: "company", heartbeatRunId: input.notification.id,
      phase: "workspace_finalize", status: "succeeded", command: null }];
    const requested: string[] = [];
    const api = { async get<T>(path: string): Promise<T> {
      requested.push(path);
      const url = new URL(path, "http://fixture.invalid");
      if (url.pathname.endsWith("/workspace-operations")) return workspaceOperations as T;
      if (url.pathname.endsWith("/log")) return { content: "recorded completion notification" } as T;
      if (url.pathname.endsWith("/events")) return recorded.events.filter(e => e.seq > Number(url.searchParams.get("afterSeq"))) as T;
      throw new Error("Unexpected evidence endpoint");
    } };
    const collected = await collectChatRunEvidence(api, input.notification, false, true);
    expect(verifyChatCompletion(input.runs, { ...input.completionEvidence, runEvidence: [collected] }))
      .toMatchObject({ ordinaryProviderRuns: 2, totalProviderRuns: 3 });
    expect(requested).toContain(`/api/heartbeat-runs/${input.notification.id}/workspace-operations`);
    expect(collected).toMatchObject({ workspaceOperations });
    requested.length = 0;
    await collectChatRunEvidence(api, input.notification);
    expect(requested).not.toContain(`/api/heartbeat-runs/${input.notification.id}/workspace-operations`);
  });

  for (const [eventType, payload] of [
    ["item.completed", { kind: "fileChange", item: { type: "fileChange", changes: [{ path: "extra.txt" }] } }],
    ["item.started", { kind: "commandExecution", item: { type: "commandExecution", command: "unexpected work" } }],
    ["item.completed", { kind: "webSearch", item: { type: "webSearch" } }],
    ["workspace.change.updated", { schema: "paperclip.workspace.diff.v1", files: [{ path: "extra.txt", operation: "add" }] }],
    ["research.search.started", { query: "unexpected research" }],
    ["item.completed", { kind: "dynamicToolCall", item: { type: "tool_use", id: "hidden", name: "create_task" } }],
    ["item.completed", { kind: "unknown_provider_work" }],
    ["item.completed", { kind: "agentMessage", item: { type: "fileChange" } }],
    ["unrecognized.provider.work", {}],
  ] as const) it(`rejects native work without a Paperclip tool event: ${eventType}/${"kind" in payload ? payload.kind : "event"}`, () => {
    const input = completionRecording();
    input.completionEvidence.runEvidence[0]!.events.push({ companyId: "company", agentId: "agent",
      runId: input.notification.id, eventType, seq: 4,
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", runId: input.notification.id, eventType, payload } } });
    expect(() => verifyChatCompletion(input.runs, input.completionEvidence)).toThrow(/Chat completion proof:/);
  });

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

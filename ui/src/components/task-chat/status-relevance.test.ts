import { describe, expect, it } from "vitest";
import type { ExecutionProjection } from "@paperclipai/shared";
import type { IssueChatComment } from "@/lib/issue-chat-messages";
import { taskChatStatusRelevance, withoutHistoricalRunStatus } from "./status-relevance";
import type { TaskChatItem } from "./task-chat-model";

const oldRun = {
  id: "old", agentId: "agent", status: "failed",
  createdAt: "2025-01-01T10:00:00Z", startedAt: "2025-01-01T10:00:01Z",
};
const nextRun = { ...oldRun, id: "next", status: "succeeded", createdAt: "2025-01-01T10:01:00Z", startedAt: "2025-01-01T10:01:01Z" };
const hold: ExecutionProjection = {
  phase: "recovery_needed", label: "Stopped", cause: "uncertain_provider_action",
  lastConfirmedActivityAt: null, retryAt: null, attempt: 1, maxAttempts: 3,
  recoveryOwner: "board", nextAction: "Check the execution", permittedActions: ["inspect_recovery"],
  predecessorRunId: null, successorRunId: null,
};
const notice: IssueChatComment = {
  id: "notice", companyId: "company", issueId: "issue", authorType: "system",
  authorAgentId: null, authorUserId: null, body: "Execution needs attention.",
  presentation: null, metadata: { version: 1, sourceRunId: "old", sections: [] },
  createdAt: new Date("2025-01-01T10:00:30Z"), updatedAt: new Date("2025-01-01T10:00:30Z"),
};

describe("task chat status relevance", () => {
  it("uses attempt creation order regardless of API order or a late finish", () => {
    for (const runs of [[oldRun, nextRun], [nextRun, oldRun]]) {
      const policy = taskChatStatusRelevance("in_progress", runs);
      expect(policy.isHistoricalRun("old")).toBe(true);
      expect(policy.isHistoricalRun("next")).toBe(false);
    }
  });

  it("keeps an unresolved failure regardless of its age or missing provenance", () => {
    const policy = taskChatStatusRelevance("blocked", [oldRun]);
    expect(policy.isHistoricalRun("old")).toBe(false);
    expect(policy.isHistoricalRun("unloaded")).toBe(false);
    expect(policy.isHistoricalNotice(notice)).toBe(false);
  });

  it("does not treat another agent or a refused admission as a replacement", () => {
    for (const later of [
      { ...nextRun, agentId: "other-agent" },
      { ...nextRun, status: "cancelled", startedAt: null, errorCode: "execution_reconciliation_required" },
    ]) {
      expect(taskChatStatusRelevance("blocked", [oldRun, later]).isHistoricalRun("old")).toBe(false);
    }
  });

  it("hides earlier observations of a wait and clears the latest wait after work starts", () => {
    const wait = { ...oldRun, status: "cancelled", startedAt: null, errorCode: "execution_reconciliation_required" };
    const newerWait = { ...wait, id: "newer-wait", createdAt: "2025-01-01T10:00:30Z" };
    expect(taskChatStatusRelevance("blocked", [wait, newerWait]).isHistoricalRun("old")).toBe(true);
    expect(taskChatStatusRelevance("blocked", [wait, newerWait]).isHistoricalRun("newer-wait")).toBe(false);
    expect(taskChatStatusRelevance("in_progress", [wait, newerWait, nextRun]).isHistoricalRun("newer-wait")).toBe(true);
  });

  it("preserves an explicit hold until a successor or terminal task resolves it", () => {
    const held = { ...oldRun, execution: hold };
    expect(taskChatStatusRelevance("blocked", [held, nextRun]).isHistoricalRun("old")).toBe(false);
    expect(taskChatStatusRelevance("blocked", [held, oldRun, nextRun]).isHistoricalRun("old")).toBe(false);
    expect(taskChatStatusRelevance("blocked", [{ ...held, execution: { ...hold, successorRunId: "next" } }]).isHistoricalRun("old")).toBe(true);
    expect(taskChatStatusRelevance("done", [held]).isHistoricalRun("old")).toBe(true);
  });

  it("uses resolved recovery evidence even without a successor run", () => {
    const waiting = { ...oldRun, resultJson: { executionWait: { recoveryActionId: "action" } } };
    const recoveryNotice = { ...notice, metadata: { version: 1 as const, sections: [], recovery: {
      kind: "disposition_repair_escalated" as const, actionId: "action", attemptCount: 1,
      maxAttempts: 3, reason: "missing result", assigneeAgentId: "agent",
    } } };
    for (const status of ["active", "escalated", "resolved", "cancelled"] as const) {
      const action = { id: "action", status };
      const policy = taskChatStatusRelevance("blocked", [waiting, nextRun], action);
      expect(policy.isHistoricalRun("old")).toBe(status === "resolved" || status === "cancelled");
      expect(policy.isHistoricalNotice(recoveryNotice)).toBe(status === "resolved" || status === "cancelled");
    }
  });

  it("hides old system notices by provenance without hiding authored messages or session boundaries", () => {
    const policy = taskChatStatusRelevance("in_progress", [oldRun, nextRun]);
    expect(policy.isHistoricalNotice({ ...notice, metadata: { version: 1, sourceRunId: "old", sections: [] } })).toBe(true);
    expect(policy.isHistoricalNotice({ ...notice, metadata: null, createdByRunId: "next" })).toBe(false);
    expect(policy.isHistoricalNotice({ ...notice, metadata: null, createdByRunId: "unknown" })).toBe(false);
    expect(policy.isHistoricalNotice(notice)).toBe(true);
    expect(policy.isHistoricalNotice({ ...notice, authorType: "agent" })).toBe(false);
    expect(policy.isHistoricalNotice({ ...notice, authorType: "user" })).toBe(false);
    expect(policy.isHistoricalNotice({ ...notice, conversationSessionGeneration: 1 })).toBe(false);
  });

  it.each(["done", "cancelled"])("hides obsolete notices on %s tasks even without loaded runs", (status) => {
    const policy = taskChatStatusRelevance(status, []);
    expect(policy.isHistoricalRun("unloaded")).toBe(true);
    expect(policy.isHistoricalNotice(notice)).toBe(true);
    expect(policy.isHistoricalNotice({ ...notice, authorType: "agent" })).toBe(false);
  });

  it.each(["in_progress", "done", "cancelled"])("preserves unrelated system updates on %s tasks after later work", (status) => {
    const policy = taskChatStatusRelevance(status, [oldRun, nextRun]);
    const relay = { ...notice, metadata: null, body: "A child task is still blocked." };
    expect(policy.isHistoricalNotice(relay)).toBe(false);
    expect(policy.isHistoricalNotice({ ...relay, presentation: {
      kind: "system_notice", title: "Child task blocked", tone: "warning", detailsDefaultOpen: false,
    } })).toBe(false);
  });

  it("keeps uncertainty visible when timestamps are missing or tied", () => {
    const invalid = { ...nextRun, createdAt: "invalid", startedAt: null };
    expect(taskChatStatusRelevance("blocked", [oldRun, invalid]).isHistoricalRun("old")).toBe(false);
    expect(taskChatStatusRelevance("blocked", [oldRun, { ...nextRun, createdAt: oldRun.createdAt }]).isHistoricalRun("old")).toBe(false);
  });
});

it("removes run lifecycle diagnostics while retaining tool failures and pending permission requests", () => {
  const retained: TaskChatItem[] = [
    { id: "reply", kind: "message", author: "agent", text: "Saved the result." },
    { id: "tool", kind: "tool", name: "Read", status: "failed" },
    { id: "approval", kind: "protocol", surface: "runtime_request", runId: "old", requestId: "permission",
      requestKind: "command_approval", turnId: "turn", requestType: "permission", choices: [], fields: [],
      status: "pending", prompt: "Allow the command?" },
  ];
  const items: TaskChatItem[] = [
    ...retained,
    { id: "failed", kind: "marker", variant: "interrupted", label: "Run failed" },
    { id: "system", kind: "message", author: "system", text: "Waiting to resume" },
    { id: "wait", kind: "protocol", surface: "provider_activity", family: "wait", title: "Waiting", status: "completed",
      eventType: "wait", details: [], steps: [], links: [], children: [] },
    { id: "terminal", kind: "protocol", surface: "run_terminal", turnState: "failed", runState: "failed", disposition: "blocked" },
  ];
  expect(withoutHistoricalRunStatus(items)).toEqual(retained);
  expect(items).toHaveLength(7);
});

import { describe, expect, it } from "vitest";
import { attentionReceiptText, type AttentionItem, type DecisionHistoryItem } from "@paperclipai/shared";
import {
  COORDINATOR_RECENT_DECISION_MS,
  DECISION_HISTORY_OUTCOME_OPTIONS,
  decisionHistoryContext,
  decisionHistoryHeadline,
  pendingDecisionTaskIds,
  recentDecisionReceipts,
} from "./coordinator-attention";

describe("Coordinator attention projections", () => {
  it("lists one task for two pending decisions and removes it only after the last decision leaves", () => {
    const first = { subject: { id: "question", kind: "interaction" }, relatedIssue: { id: "task" } } as AttentionItem;
    const second = { subject: { id: "approval", kind: "interaction" }, relatedIssue: { id: "task" } } as AttentionItem;
    expect([...pendingDecisionTaskIds([first, second])]).toEqual(["task"]);
    expect([...pendingDecisionTaskIds([second])]).toEqual(["task"]);
    expect([...pendingDecisionTaskIds([])]).toEqual([]);
  });
  it("decays recent presentation while preserving the source decision history", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    const history = [{ id: "question", resolvedAt: new Date(now).toISOString() }, { id: "old", resolvedAt: new Date(now - COORDINATOR_RECENT_DECISION_MS).toISOString() }] as DecisionHistoryItem[];
    expect(recentDecisionReceipts(history, now).map((item) => item.id)).toEqual(["question"]);
    expect(history).toHaveLength(2);
    expect(recentDecisionReceipts(history, now + COORDINATOR_RECENT_DECISION_MS)).toEqual([]);
  });
  it("keeps a task needing a separate stalled-review decision in the same attention projection", () => {
    const review = { sourceKind: "review", subject: { id: "task", kind: "issue", metadata: { reviewAttentionState: "stalled" } } } as unknown as AttentionItem;
    expect([...pendingDecisionTaskIds([review])]).toEqual(["task"]);
    expect([...pendingDecisionTaskIds([])]).toEqual([]);
  });
});

describe("Decision history presentation (PAP-749 task 2e)", () => {
  const entry = (overrides: Partial<DecisionHistoryItem>) => ({
    id: "issue_thread_interaction:a", sourceKind: "issue_thread_interaction", sourceId: "a", issueId: "task-1", issueIdentifier: "PAP-1",
    issueTitle: "Launch copy", title: "Copy review", label: "Withdrawn by user", outcome: "cancelled", resultOutcome: "withdrawn",
    resolvedAt: "2026-10-30T12:00:00.000Z", resolvedByUserId: "scott", resolvedByAgentId: null, agentId: null, agentName: null,
    projectId: null, projectName: null, href: "/PAP/issues/PAP-1#interaction-a", target: null, ...overrides,
  }) as DecisionHistoryItem;

  it("offers Withdrawn, Expired and Closed with task as separate outcome filters", () => {
    expect(DECISION_HISTORY_OUTCOME_OPTIONS.map((option) => option.label)).toEqual(expect.arrayContaining(["Withdrawn", "Expired", "Closed with task"]));
    expect(DECISION_HISTORY_OUTCOME_OPTIONS.find((option) => option.label === "Closed with task")?.value).toBe("issue_closed");
  });

  it("names who withdrew a card and keeps every other label", () => {
    const labels = new Map([["scott", "Scott"]]);
    expect(decisionHistoryHeadline(entry({}), labels)).toBe("Withdrawn by @Scott");
    expect(decisionHistoryHeadline(entry({ resolvedByUserId: null, label: "Withdrawn" }), labels)).toBe("Withdrawn");
    expect(decisionHistoryHeadline(entry({ resultOutcome: null, label: "Approved", outcome: "accepted" }), labels)).toBe("Approved");
  });

  it("names who acted with the receipt's verb for the same action (PAP-767)", () => {
    const labels = new Map([["scott", "Scott"], ["dotta", "Dotta"]]);
    const approved = entry({ resultOutcome: null, label: "Approved", outcome: "accepted", action: { outcome: "approved", detail: null } });
    expect(decisionHistoryHeadline(approved, labels)).toBe("Approved by @Scott");
    expect(decisionHistoryHeadline(approved, labels)).toBe(attentionReceiptText({ outcome: "approved", actorLabel: "Scott" }));
    const keptPaused = entry({ sourceKind: "approval", resultOutcome: null, label: "Kept paused", outcome: "rejected",
      resolvedByUserId: "dotta", action: { outcome: "kept_paused", detail: null } });
    expect(decisionHistoryHeadline(keptPaused, labels)).toBe("Kept paused by @Dotta");
    const decided = entry({ sourceKind: "decision", resultOutcome: null, label: "Ship it", outcome: "decided", action: { outcome: "decided", detail: "Ship it" } });
    expect(decisionHistoryHeadline(decided, labels)).toBe("Decided by @Scott: Ship it");
    // An expired card has no actor: the label stays.
    expect(decisionHistoryHeadline(entry({ resultOutcome: null, label: "Expired", outcome: "expired", resolvedByUserId: null, action: null }), labels)).toBe("Expired");
  });

  it("shows the task, or names an approval that has no task", () => {
    expect(decisionHistoryContext(entry({}))).toBe("PAP-1 · Launch copy");
    expect(decisionHistoryContext(entry({ sourceKind: "approval", issueId: null, issueIdentifier: null, issueTitle: null, title: "Hire a designer" })))
      .toBe("Approval · Hire a designer");
  });
});

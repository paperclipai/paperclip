import { describe, expect, it } from "vitest";
import { attentionReceiptText, type AttentionItem, type DecisionHistoryItem } from "@paperclipai/shared";
import {
  COORDINATOR_RECENT_DECISION_MS,
  DECISION_HISTORY_OUTCOME_OPTIONS,
  coordinatorAudienceKey,
  coordinatorAssignee,
  coordinatorAssigneeTarget,
  coordinatorCardDetail,
  coordinatorCardTitle,
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

  it("titles a card the way Needs You shows it, for the Withdraw all stale list (PAP-767)", () => {
    const base = {
      id: "c", sourceKind: "issue_thread_interaction", inlineResolvable: true,
      subject: { id: "i", kind: "interaction", title: "Lingering on a done task", metadata: {} },
      relatedIssue: { id: "t", identifier: "PAP-19", title: "Confirmation on a done task" }, whyNow: "Why",
    } as unknown as AttentionItem;
    // An inline interaction card is named by its task link.
    expect(coordinatorCardTitle(base)).toBe("Confirmation on a done task");
    // Every other card leads with its heading.
    expect(coordinatorCardTitle({ ...base, sourceKind: "approval", subject: { ...base.subject, kind: "approval", title: "Approve the plan" } } as AttentionItem))
      .toBe("Approve the plan");
    expect(coordinatorCardTitle({ ...base, inlineResolvable: false } as AttentionItem)).toBe("Lingering on a done task");
  });

  it("gives a card titled with its bare task or agent name an ask, and explains a stuck task (PAP-770)", () => {
    const blocker = {
      id: "b", sourceKind: "blocker_attention", inlineResolvable: false, whyNow: "Blocks 0 tasks and needs human attention.",
      subject: { id: "t", kind: "issue", title: "Today's weather forecast", metadata: {} }, relatedIssue: null,
      detail: { kind: "blocker", blockingIssue: null, blockedTaskCount: 0, images: [] },
    } as unknown as AttentionItem;
    expect(coordinatorCardTitle(blocker)).toBe("Get “Today's weather forecast” moving again");
    expect(coordinatorCardDetail(blocker, null)).toBe("No one is working on it. Unblock it, reassign it, or nudge its owner.");
    const holding = { ...blocker, detail: { kind: "blocker", blockingIssue: null, blockedTaskCount: 2, images: [] } } as unknown as AttentionItem;
    expect(coordinatorCardDetail(holding, null)).toBe("It's holding up 2 tasks, and no one is working on it. Unblock it, reassign it, or nudge its owner.");
    const agentError = { ...blocker, sourceKind: "agent_error_alert", subject: { id: "a", kind: "agent", title: "Chief of Staff" },
      detail: { kind: "agent_error", agentName: "Chief of Staff", failureReasonExcerpt: null, images: [] } } as unknown as AttentionItem;
    expect(coordinatorCardTitle(agentError)).toBe("Chief of Staff hit an error and needs help");
  });

  it("shows the task, or names an approval that has no task", () => {
    expect(decisionHistoryContext(entry({}))).toBe("PAP-1 · Launch copy");
    expect(decisionHistoryContext(entry({ sourceKind: "approval", issueId: null, issueIdentifier: null, issueTitle: null, title: "Hire a designer" })))
      .toBe("Approval · Hire a designer");
  });
});

describe("who a card is for (PAP-775)", () => {
  const card = (audience: unknown) => ({ audience }) as Pick<AttentionItem, "audience">;
  it("keys a card by its person, No owner yet or Company", () => {
    expect(coordinatorAudienceKey(card({ kind: "user", userId: "dotta", reason: "addressee" }))).toBe("user:dotta");
    expect(coordinatorAudienceKey(card({ kind: "pool", userId: null, reason: "none" }))).toBe("unassigned");
    expect(coordinatorAudienceKey(card({ kind: "company", userId: null, reason: "none" }))).toBe("company");
  });

  it("maps the assignee filter to a view and back", () => {
    expect(coordinatorAssignee("mine", null)).toBe("me");
    expect(coordinatorAssignee("all", null)).toBe("all");
    expect(coordinatorAssignee("all", "dotta")).toBe("user:dotta");
    expect(coordinatorAssignee("archived", null)).toBeNull();
    expect(coordinatorAssigneeTarget("user:dotta", "scott")).toEqual({ view: "all", forUserId: "dotta" });
    expect(coordinatorAssigneeTarget("user:scott", "scott")).toEqual({ view: "mine", forUserId: null });
    expect(coordinatorAssigneeTarget("unassigned", "scott")).toEqual({ view: "unassigned", forUserId: null });
  });
});

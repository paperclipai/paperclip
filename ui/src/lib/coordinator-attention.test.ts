import { describe, expect, it } from "vitest";
import type { AttentionItem, DecisionHistoryItem } from "@paperclipai/shared";
import { COORDINATOR_RECENT_DECISION_MS, pendingDecisionTaskIds, recentDecisionReceipts } from "./coordinator-attention";

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

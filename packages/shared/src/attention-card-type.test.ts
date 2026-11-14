import { describe, expect, it } from "vitest";
import { attentionCardType, type AttentionItem } from "./index.js";

const card = (sourceKind: AttentionItem["sourceKind"], metadata: Record<string, unknown> = {}) =>
  ({ sourceKind, subject: { kind: "issue", id: "x", companyId: "c", title: null, identifier: null, status: null, href: null, metadata } }) as Pick<AttentionItem, "sourceKind" | "subject">;

describe("attentionCardType (PAP-775)", () => {
  it("picks the interaction design from its kind and what it confirms", () => {
    expect(attentionCardType(card("issue_thread_interaction", { kind: "ask_user_questions" }))).toBe("answer_questions");
    expect(attentionCardType(card("issue_thread_interaction", { kind: "suggest_tasks" }))).toBe("suggested_tasks");
    expect(attentionCardType(card("issue_thread_interaction", { kind: "request_confirmation", isPlanTarget: true }))).toBe("review_plan");
    expect(attentionCardType(card("issue_thread_interaction", { kind: "request_confirmation", requestKind: "deliverable" }))).toBe("review_deliverable");
    expect(attentionCardType(card("issue_thread_interaction", { kind: "request_confirmation", requestKind: "tool_action" }))).toBe("tool_access");
    expect(attentionCardType(card("issue_thread_interaction", { kind: "request_confirmation", requestKind: "connection" }))).toBe("connect_service");
    expect(attentionCardType(card("issue_thread_interaction", { kind: "request_confirmation" }))).toBe("confirm");
  });

  it("maps every other source to its own design", () => {
    expect(attentionCardType(card("approval", { type: "hire_agent" }))).toBe("board_approval");
    expect(attentionCardType(card("join_request"))).toBe("join_request");
    expect(attentionCardType(card("review"))).toBe("review_task");
    expect(attentionCardType(card("review", { reviewAttentionState: "stalled" }))).toBe("blocked_task");
    expect(attentionCardType(card("blocker_attention"))).toBe("blocked_task");
    expect(attentionCardType(card("agent_error_alert"))).toBe("failed_run");
    expect(attentionCardType(card("budget_alert"))).toBe("budget_stop");
    expect(attentionCardType(card("recovery_action"))).toBe("recovery");
    expect(attentionCardType(card("decision"))).toBe("make_choice");
  });
});

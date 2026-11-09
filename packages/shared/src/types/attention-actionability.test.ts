import { describe, expect, it } from "vitest";
import { isActionableAttention, type AttentionItem } from "./attention.js";

const item = (sourceKind: AttentionItem["sourceKind"], inlineResolvable = true, metadata = {}) =>
  ({ sourceKind, inlineResolvable, subject: { kind: "issue", metadata } } as AttentionItem);

describe("inbox actionability", () => {
  it.each(["approval", "decision", "issue_thread_interaction", "join_request"] as const)("keeps %s with its resolver", kind => {
    expect(isActionableAttention(item(kind))).toBe(true);
    expect(isActionableAttention(item(kind, false))).toBe(false);
  });
  it("keeps human recovery choices even though they are technical", () => {
    expect(isActionableAttention(item("recovery_action", false, { hasResolutionActions: true }))).toBe(true);
    expect(isActionableAttention(item("recovery_action", false))).toBe(false);
  });
  it("keeps stalled reviews but leaves live reviewer work with its owner", () => {
    expect(isActionableAttention(item("review", true, { reviewAttentionState: "stalled" }))).toBe(true);
    expect(isActionableAttention(item("review", true, { reviewAttentionState: "covered" }))).toBe(false);
  });
  it.each(["agent_error_alert", "failed_run", "blocker_attention", "budget_alert"] as const)("does not turn an unresolvable %s notice into user work", kind => {
    expect(isActionableAttention(item(kind))).toBe(false);
  });
});

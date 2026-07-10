import { describe, expect, it } from "vitest";
import type { AttentionFeed, AttentionItem, AttentionSourceKind } from "@paperclipai/shared";
import { attentionBadgeCount, isInlineResolvable, severityStyle, sourceMeta } from "./attention";

function buildItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "a1",
    companyId: "c1",
    sourceKind: "approval",
    subject: { kind: "approval", id: "s1", companyId: "c1", title: "t", identifier: null, status: null, href: null },
    whyNow: "why",
    decisionVerbs: [],
    inlineResolvable: true,
    entryRule: "",
    exitRule: "",
    dedupKey: "d1",
    dismissalKey: "attention:d1",
    severity: "medium",
    rank: 0,
    activityAt: "2026-07-09T12:00:00Z",
    createdAt: "2026-07-09T12:00:00Z",
    updatedAt: "2026-07-09T12:00:00Z",
    relatedIssue: null,
    ...overrides,
  };
}

describe("isInlineResolvable", () => {
  it("is true for approvals/interactions/join when server flags inlineResolvable", () => {
    for (const kind of ["approval", "issue_thread_interaction", "join_request"] as AttentionSourceKind[]) {
      expect(isInlineResolvable(buildItem({ sourceKind: kind, inlineResolvable: true }))).toBe(true);
    }
  });

  it("is false when the server marks a row non-inline (e.g. board approval)", () => {
    expect(isInlineResolvable(buildItem({ sourceKind: "approval", inlineResolvable: false }))).toBe(false);
  });

  it("is never inline for reviews even when flagged", () => {
    expect(isInlineResolvable(buildItem({ sourceKind: "review", inlineResolvable: true }))).toBe(false);
  });

  it("deep-links recovery/failure/budget rows rather than inlining", () => {
    for (const kind of ["recovery_action", "failed_run", "budget_alert", "blocker_attention"] as AttentionSourceKind[]) {
      expect(isInlineResolvable(buildItem({ sourceKind: kind, inlineResolvable: true }))).toBe(false);
    }
  });
});

describe("attentionBadgeCount", () => {
  it("counts every queue row as a decision (mentions/unread never enter the feed)", () => {
    const feed: AttentionFeed = {
      companyId: "c1",
      generatedAt: "2026-07-09T12:00:00Z",
      totalCount: 3,
      countsBySourceKind: {} as AttentionFeed["countsBySourceKind"],
      items: [buildItem({ id: "1" }), buildItem({ id: "2" }), buildItem({ id: "3" })],
    };
    expect(attentionBadgeCount(feed)).toBe(3);
  });

  it("is zero for an empty or missing feed", () => {
    expect(attentionBadgeCount(null)).toBe(0);
    expect(attentionBadgeCount(undefined)).toBe(0);
  });
});

describe("sourceMeta + severityStyle", () => {
  it("labels every catalog source kind", () => {
    const kinds: AttentionSourceKind[] = [
      "approval",
      "issue_thread_interaction",
      "join_request",
      "recovery_action",
      "productivity_review",
      "blocker_attention",
      "review",
      "failed_run",
      "budget_alert",
      "agent_error_alert",
    ];
    for (const kind of kinds) {
      expect(sourceMeta(kind).label.length).toBeGreaterThan(0);
      expect(sourceMeta(kind).icon).toBeTruthy();
    }
  });

  it("maps escalation severity to distinct accents", () => {
    expect(severityStyle("critical").accent).not.toBe(severityStyle("low").accent);
  });
});

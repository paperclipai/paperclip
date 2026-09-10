import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DecisionBundleHeader,
  decisionHistoryCount,
  decisionHistoryQueryEnabled,
  resolveDecisionDeepLink,
} from "./WhatNeedsMe";

describe("WhatNeedsMe decision history", () => {
  it("defers terminal-history queries until their curtain opens", () => {
    expect(decisionHistoryQueryEnabled("company-1", false)).toBe(false);
    expect(decisionHistoryQueryEnabled("company-1", true)).toBe(true);
    expect(decisionHistoryQueryEnabled(null, true)).toBe(false);
  });

  it("discloses when terminal history exceeds the visible window", () => {
    expect(decisionHistoryCount(undefined)).toBeUndefined();
    expect(decisionHistoryCount(49)).toBe(49);
    expect(decisionHistoryCount(50)).toBe(50);
    expect(decisionHistoryCount(51)).toBe("50+");
  });

  it("labels general bundles as decisions instead of cleanups", () => {
    const single = renderToStaticMarkup(
      <DecisionBundleHeader agentName="Planner" title="Choose a route" originIssue={null} count={1} />,
    );
    const multiple = renderToStaticMarkup(
      <DecisionBundleHeader agentName="Planner" title="Choose routes" originIssue={null} count={2} />,
    );

    expect(single).toContain("Planner proposed 1 decision");
    expect(multiple).toContain("Planner proposed 2 decisions");
    expect(single).not.toContain("cleanup");
    expect(multiple).not.toContain("cleanup");
  });
});

describe("WhatNeedsMe decision deep links", () => {
  it("focuses an open gate straight from the feed", () => {
    expect(
      resolveDecisionDeepLink({
        decisionId: "decision-1",
        openAttentionItemId: "attention-1",
        detail: undefined,
        detailError: null,
      }),
    ).toEqual({ kind: "open", attentionItemId: "attention-1" });
  });

  it("routes a decided or expired link to the history curtain that owns it", () => {
    expect(
      resolveDecisionDeepLink({
        decisionId: "decision-1",
        openAttentionItemId: null,
        detail: { status: "decided" },
        detailError: null,
      }),
    ).toEqual({ kind: "history", decisionId: "decision-1", status: "decided" });
    expect(
      resolveDecisionDeepLink({
        decisionId: "decision-2",
        openAttentionItemId: null,
        detail: { status: "expired" },
        detailError: null,
      }),
    ).toEqual({ kind: "history", decisionId: "decision-2", status: "expired" });
  });

  it("waits while neither the feed nor the record has settled", () => {
    expect(
      resolveDecisionDeepLink({
        decisionId: "decision-1",
        openAttentionItemId: null,
        detail: undefined,
        detailError: null,
      }),
    ).toEqual({ kind: "pending" });
  });

  it("reports an unresolvable link instead of landing on the generic queue", () => {
    expect(
      resolveDecisionDeepLink({
        decisionId: "decision-1",
        openAttentionItemId: null,
        detail: undefined,
        detailError: new Error("Decision not found"),
      }),
    ).toEqual({ kind: "unavailable", reason: "error" });
    expect(
      resolveDecisionDeepLink({
        decisionId: "decision-1",
        openAttentionItemId: null,
        detail: { status: "cancelled" },
        detailError: null,
      }),
    ).toEqual({ kind: "unavailable", reason: "unlisted" });
    // Still open, but filtered out of the queue on screen: not a history row.
    expect(
      resolveDecisionDeepLink({
        decisionId: "decision-1",
        openAttentionItemId: null,
        detail: { status: "open" },
        detailError: null,
      }),
    ).toEqual({ kind: "unavailable", reason: "unlisted" });
  });

});

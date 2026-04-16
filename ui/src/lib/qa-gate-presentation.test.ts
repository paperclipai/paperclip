import { describe, expect, it } from "vitest";
import { getSmartReviewPresentation } from "./qa-gate-presentation";

describe("getSmartReviewPresentation", () => {
  it("offers a Start QA action before the issue enters QA", () => {
    expect(
      getSmartReviewPresentation({
        issueStatus: "todo",
        lastQaSummaryAt: null,
      }),
    ).toEqual({
      actionLabel: "Start QA",
      actionStatus: "in_review",
      statusLabel: "Not in QA yet",
    });
  });

  it("keeps the QA Ship action once the issue is in review", () => {
    expect(
      getSmartReviewPresentation({
        issueStatus: "in_review",
        lastQaSummaryAt: null,
      }),
    ).toEqual({
      actionLabel: "QA Ship",
      actionStatus: "done",
      statusLabel: "No QA summary yet",
    });
  });

  it("disables the action for terminal issues and preserves summary recency", () => {
    const lastQaSummaryAt = new Date("2026-04-15T12:00:00Z");
    expect(
      getSmartReviewPresentation({
        issueStatus: "done",
        lastQaSummaryAt,
      }),
    ).toEqual({
      actionLabel: "QA Closed",
      actionStatus: null,
      statusLabel: `Last summary ${lastQaSummaryAt.toISOString()}`,
    });
  });
});

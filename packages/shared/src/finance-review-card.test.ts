import { describe, expect, it } from "vitest";

import {
  FINANCE_REVIEW_CARD_DOCUMENT_KEY,
  formatFinanceReviewCard,
  summarizeFinancePendingReview,
  type FinancePendingReviewArtifact,
} from "./finance-review-card.js";

const pendingArtifact: FinancePendingReviewArtifact = {
  artifactType: "financial_workbook_pending_review_v1",
  reviewMode: "pending",
  finalizationStatus: "not_finalized",
  sourceWorkbook: "Financials June 2026.xlsx",
  sourcePath: "Financials June 2026.xlsx",
  sourceSha256: "abc123",
  importRunId: "abc123:2026-06",
  actualThroughPeriod: "2026-06",
  integrityStatus: "ready_with_exceptions",
  pendingReviewCount: 3,
  acceptedRecordCount: 120,
  rejectedRecordCount: 0,
  conflictCount: 0,
  baselineDifferenceCount: 2,
  reconciliationSummary: {
    differenceCount: 2,
    differences: [
      { metricKey: "gross_revenue", displayLabel: "Gross Revenue", period: "2026-06", diff: 1200 },
      { metricKey: "ad_spend", displayLabel: "Ad spend", period: "2026-06", diff: -300 },
    ],
  },
  integritySummary: { status: "ready_with_exceptions" },
  reviewItems: [{ type: "sheet_modeling", title: "CF Predict is still deferred" }],
  pendingRecords: [
    {
      metricKey: "gross_revenue",
      displayLabel: "Gross Revenue",
      family: "core",
      period: "2026-06",
      timeGrain: "monthly",
      scenario: "actual",
      value: 123456,
      unit: "currency",
      dimensions: null,
      reviewStatus: "pending_review",
      sourceSheet: "P&L (Monthly)",
      sourceRange: "AA10",
      sourceGroup: "income_statement",
      parserId: "pnl:v1",
    },
  ],
  nextActions: [
    "Review changed or unaccepted metrics before syncing actuals.",
    "Compare suspicious deltas against CFO/PBI source exports.",
    "Promote only accepted records into downstream metric sync.",
  ],
};

describe("finance review card", () => {
  it("summarizes a CFO pending-review artifact without marking numbers finalized", () => {
    const summary = summarizeFinancePendingReview(pendingArtifact);

    expect(summary).toEqual(expect.objectContaining({
      documentKey: FINANCE_REVIEW_CARD_DOCUMENT_KEY,
      title: "June financials need review",
      sourceWorkbook: "Financials June 2026.xlsx",
      finalizationStatus: "not_finalized",
      pendingReviewCount: 3,
      acceptedRecordCount: 120,
      differenceCount: 2,
      integrityStatus: "ready_with_exceptions",
      nextActionLabel: "Review CFO financials",
    }));
    expect(summary.primaryMetrics).toEqual([
      "Gross Revenue · 2026-06 · 123456",
    ]);
  });

  it("formats a low-word Paperclip card with explicit review actions", () => {
    const card = formatFinanceReviewCard(pendingArtifact);

    expect(card.documentKey).toBe(FINANCE_REVIEW_CARD_DOCUMENT_KEY);
    expect(card.title).toBe("June financials need review");
    expect(card.markdown).toContain("# June financials need review");
    expect(card.markdown).toContain("Status: not finalized");
    expect(card.markdown).toContain("Pending review: 3");
    expect(card.markdown).toContain("Integrity: ready_with_exceptions");
    expect(card.markdown).toContain("## Actions");
    expect(card.markdown).toContain("- Review");
    expect(card.markdown).toContain("- Compare to PBI");
    expect(card.markdown).toContain("- Ask CFO");
    expect(card.markdown).toContain("- Hold");
    expect(card.markdown).not.toContain("schema:");
    expect(card.markdown).not.toContain("financial_workbook_pending_review_v1");
  });
});

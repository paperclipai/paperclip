import { describe, expect, it } from "vitest";
import {
  RELIABILITY_SCORECARD_DOCUMENT_KEY,
  reliabilityScorecardDocumentSchema,
  formatReliabilityScorecardDocumentBody,
  parseReliabilityScorecardDocumentBody,
} from "../index.js";

describe("reliability scorecard validators", () => {
  const validScorecard = {
    version: 1,
    generatedAt: "2026-05-06T00:00:00.000Z",
    companyId: "11111111-1111-4111-8111-111111111111",
    window: {
      from: "2026-05-05T00:00:00.000Z",
      to: "2026-05-06T00:00:00.000Z",
    },
    summary: {
      status: "passing",
      controlPlaneReliability: 0.9999,
      evidenceCompletenessRate: 1,
      manualRescueCount: 0,
    },
    metrics: [
      { key: "scoped_wake_success_rate", label: "Scoped wake success rate", value: 1, unit: "ratio" },
      { key: "orphan_process_count", label: "Orphan process count", value: 0, unit: "count" },
    ],
    topBlockers: [
      { class: "workspace_preflight", count: 1, blockedMinutes: 12 },
    ],
  } as const;

  it("parses strict reliability scorecards", () => {
    const parsed = reliabilityScorecardDocumentSchema.parse(validScorecard);

    expect(RELIABILITY_SCORECARD_DOCUMENT_KEY).toBe("reliability_scorecard");
    expect(parsed.summary.status).toBe("passing");
    expect(parsed.metrics[0]?.key).toBe("scoped_wake_success_rate");
  });

  it("rejects invalid ratios and duplicate metric keys", () => {
    const invalidRatio = reliabilityScorecardDocumentSchema.safeParse({
      ...validScorecard,
      summary: { ...validScorecard.summary, controlPlaneReliability: 1.1 },
    });
    const duplicateMetric = reliabilityScorecardDocumentSchema.safeParse({
      ...validScorecard,
      metrics: [
        { key: "same", label: "Same", value: 1 },
        { key: "same", label: "Same again", value: 2 },
      ],
    });

    expect(invalidRatio.success).toBe(false);
    expect(duplicateMetric.success).toBe(false);
  });

  it("formats and parses scorecards deterministically", () => {
    const body = formatReliabilityScorecardDocumentBody(validScorecard);
    const parsed = parseReliabilityScorecardDocumentBody(body);

    expect(body).toContain("\"version\": 1");
    expect(body.endsWith("\n")).toBe(true);
    expect(parsed).toEqual(reliabilityScorecardDocumentSchema.parse(validScorecard));
  });
});

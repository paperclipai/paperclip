import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  weeklyReviewActions,
  weeklyReviewCitations,
  weeklyReviewEvents,
  weeklyReviewFindings,
  weeklyReviewRecommendations,
  weeklyReviews,
  weeklyReviewVersions,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";

import type { WeeklyReviewFindingEngineResult } from "../services/weekly-review/finding-engine.js";
import { weeklyReviewGenerationService } from "../services/weekly-review/generation.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres weekly review generation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const periodStart = new Date("2026-05-11T00:00:00.000Z");
const periodEnd = new Date("2026-05-17T23:59:59.000Z");

describeEmbeddedPostgres("weekly review generation service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-weekly-review-generation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(weeklyReviewActions);
    await db.delete(weeklyReviewRecommendations);
    await db.delete(weeklyReviewCitations);
    await db.delete(weeklyReviewFindings);
    await db.delete(weeklyReviewEvents);
    await db.delete(weeklyReviewVersions);
    await db.delete(weeklyReviews);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("generates a ready version with persisted findings, citations, recommendations, and lifecycle events", async () => {
    const companyId = await seedCompany(db);
    const service = weeklyReviewGenerationService(db, {
      computeForCompanyPeriod: async () => engineResult(companyId, "NSR-F01", "Support handoff owner missing blocks broad rollout"),
    });

    const generated = await service.generateForCompany(companyId, {
      periodStart,
      periodEnd,
      actorUserId: "board-user",
    });

    expect(generated.review.status).toBe("ready");
    expect(generated.latestVersion?.status).toBe("ready");
    expect(generated.latestVersion?.versionNumber).toBe(1);
    expect(generated.latestVersion?.narrationStatus).toBe("generated");
    expect(generated.latestVersion?.narrationText).toContain("Executive weekly review");
    expect(generated.latestVersion?.narrationText).toContain("Support handoff owner missing blocks broad rollout");
    expect(generated.findings.map((finding) => finding.stableId)).toEqual(["NSR-F01"]);
    expect(generated.citations).toHaveLength(1);
    expect(generated.recommendations).toHaveLength(1);

    const [reviewRows, versionRows, findingRows, citationRows, recommendationRows, eventRows] = await Promise.all([
      db.select().from(weeklyReviews).where(eq(weeklyReviews.companyId, companyId)),
      db.select().from(weeklyReviewVersions).where(eq(weeklyReviewVersions.companyId, companyId)),
      db.select().from(weeklyReviewFindings).where(eq(weeklyReviewFindings.companyId, companyId)),
      db.select().from(weeklyReviewCitations).where(eq(weeklyReviewCitations.companyId, companyId)),
      db.select().from(weeklyReviewRecommendations).where(eq(weeklyReviewRecommendations.companyId, companyId)),
      db.select().from(weeklyReviewEvents).where(eq(weeklyReviewEvents.companyId, companyId)),
    ]);

    expect(reviewRows).toHaveLength(1);
    expect(reviewRows[0]?.latestVersionId).toBe(versionRows[0]?.id);
    expect(versionRows).toHaveLength(1);
    expect(findingRows).toHaveLength(1);
    expect(citationRows).toHaveLength(1);
    expect(citationRows[0]?.findingId).toBe(findingRows[0]?.id);
    expect(recommendationRows).toHaveLength(1);
    expect(recommendationRows[0]?.findingId).toBe(findingRows[0]?.id);
    expect(eventRows.map((event) => event.eventType)).toEqual([
      "generation_started",
      "source_snapshot_captured",
      "findings_computed",
      "citations_validated",
      "adapter_readiness_attached",
      "model_assurance_attached",
      "narration_generated",
      "version_ready",
    ]);
  });

  it("does not read malformed child payload rows from another company", async () => {
    const companyId = await seedCompany(db);
    const otherCompanyId = await seedCompany(db);
    const service = weeklyReviewGenerationService(db, {
      computeForCompanyPeriod: async () => engineResult(companyId, "NSR-F01", "Support handoff owner missing blocks broad rollout"),
    });

    const generated = await service.generateForCompany(companyId, {
      periodStart,
      periodEnd,
      actorUserId: "board-user",
    });
    const reviewId = generated.review.id;
    const versionId = generated.latestVersion!.id;

    const [foreignFinding] = await db.insert(weeklyReviewFindings).values({
      reviewId,
      versionId,
      companyId: otherCompanyId,
      stableId: "FOREIGN-F01",
      category: "evidence_gap",
      severity: "critical",
      status: "open",
      title: "Foreign company finding",
      summary: "This malformed row must not be returned with the review payload.",
      sourceEntityType: "issue",
      sourceEntityId: "foreign-issue",
      confidence: "high",
      detectedAt: periodEnd,
      validationStatus: "valid",
    }).returning();
    await db.insert(weeklyReviewCitations).values({
      reviewId,
      versionId,
      findingId: foreignFinding.id,
      companyId: otherCompanyId,
      citationType: "evidence",
      entityType: "issue",
      entityId: "foreign-issue",
      label: "Foreign citation",
      excerpt: "Foreign company evidence must not leak.",
    });
    await db.insert(weeklyReviewRecommendations).values({
      reviewId,
      versionId,
      findingId: foreignFinding.id,
      companyId: otherCompanyId,
      kind: "request_evidence",
      severity: "critical",
      state: "open",
      title: "Foreign recommendation",
      rationale: "Foreign recommendation must not leak.",
      proposedActionJson: { kind: "request_evidence" },
    });
    await db.insert(weeklyReviewActions).values({
      reviewId,
      versionId,
      findingId: foreignFinding.id,
      recommendationId: null,
      companyId: otherCompanyId,
      actionKind: "accept_recommendation",
      status: "completed",
      targetEntityType: "weekly_review_recommendation",
      targetEntityId: "foreign-recommendation",
      requestJson: {},
      resultJson: {},
    });

    const readReview = await service.getReview(reviewId, { companyId });
    const readVersion = await service.getVersion(versionId, { companyId });

    for (const payload of [readReview, readVersion]) {
      expect(payload.findings.map((finding) => finding.companyId)).toEqual([companyId]);
      expect(payload.citations.map((citation) => citation.companyId)).toEqual([companyId]);
      expect(payload.recommendations.map((recommendation) => recommendation.companyId)).toEqual([companyId]);
      expect(payload.actions.map((action) => action.companyId)).toEqual([]);
      expect(payload.findings.map((finding) => finding.stableId)).not.toContain("FOREIGN-F01");
      expect(payload.citations.map((citation) => citation.label)).not.toContain("Foreign citation");
      expect(payload.recommendations.map((recommendation) => recommendation.title)).not.toContain("Foreign recommendation");
    }
  });

  it("refreshes into a new version without mutating the previous ready version", async () => {
    const companyId = await seedCompany(db);
    let generation = 0;
    const service = weeklyReviewGenerationService(db, {
      computeForCompanyPeriod: async () => {
        generation += 1;
        return engineResult(companyId, "NSR-F01", `Support handoff generation ${generation}`);
      },
    });

    const first = await service.generateForCompany(companyId, { periodStart, periodEnd, actorUserId: "board-user" });
    const refreshed = await service.refresh(first.review.id, { actorUserId: "board-user" });

    expect(refreshed.latestVersion?.versionNumber).toBe(2);
    expect(refreshed.review.latestVersionId).toBe(refreshed.latestVersion?.id);
    expect(refreshed.review.latestVersionId).not.toBe(first.latestVersion?.id);

    const versions = await db.select().from(weeklyReviewVersions).where(eq(weeklyReviewVersions.reviewId, first.review.id));
    const findings = await db.select().from(weeklyReviewFindings).where(eq(weeklyReviewFindings.reviewId, first.review.id));

    expect(versions.map((version) => ({ id: version.id, status: version.status, versionNumber: version.versionNumber }))).toEqual([
      { id: first.latestVersion?.id, status: "ready", versionNumber: 1 },
      { id: refreshed.latestVersion?.id, status: "ready", versionNumber: 2 },
    ]);
    expect(findings.map((finding) => finding.title).sort()).toEqual([
      "Support handoff generation 1",
      "Support handoff generation 2",
    ]);
  });

  it("keeps the previous ready version latest when refresh validation fails", async () => {
    const companyId = await seedCompany(db);
    let useInvalidResult = false;
    const service = weeklyReviewGenerationService(db, {
      computeForCompanyPeriod: async () =>
        useInvalidResult
          ? engineResult(companyId, "NSR-F04", "Research brief has one unsupported customer-segment claim", false)
          : engineResult(companyId, "NSR-F01", "Support handoff owner missing blocks broad rollout"),
    });

    const first = await service.generateForCompany(companyId, { periodStart, periodEnd, actorUserId: "board-user" });
    useInvalidResult = true;

    const failedRefresh = await service.refresh(first.review.id, { actorUserId: "board-user" });

    expect(failedRefresh.review.latestVersionId).toBe(first.latestVersion?.id);
    expect(failedRefresh.latestVersion?.id).toBe(first.latestVersion?.id);

    const versions = await db.select().from(weeklyReviewVersions).where(eq(weeklyReviewVersions.reviewId, first.review.id));
    const events = await db.select().from(weeklyReviewEvents).where(eq(weeklyReviewEvents.reviewId, first.review.id));
    const failedVersion = versions.find((version) => version.versionNumber === 2);
    const failedEvent = events.find((event) => event.eventType === "version_validation_failed");
    const narrationFailedEvent = events.find((event) => event.eventType === "narration_validation_failed");

    expect(failedVersion).toMatchObject({
      status: "validation_failed",
      narrationStatus: "validation_failed",
    });
    expect(failedVersion?.narrationText).toContain("Narration unavailable");
    expect(failedVersion?.narrationText).toContain("NSR-F04");
    expect(failedEvent).toMatchObject({
      status: "failed",
      errorCode: "citation_validation_failed",
      failureReason: "Material findings are missing valid citations",
    });
    expect(narrationFailedEvent).toMatchObject({
      status: "failed",
      errorCode: "narration_validation_failed",
    });
    expect(failedEvent?.expiresAt).not.toBeNull();
    expect(JSON.stringify(failedEvent?.debugMetadataJson)).not.toContain("sk-test-secret");
    expect(JSON.stringify(narrationFailedEvent?.debugMetadataJson)).not.toContain("sk-test-secret");
  });
});

async function seedCompany(db: ReturnType<typeof createDb>) {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: `Weekly Review ${companyId.slice(0, 8)}`,
    issuePrefix: `WR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  return companyId;
}

function engineResult(
  companyId: string,
  stableId: "NSR-F01" | "NSR-F04",
  title: string,
  valid = true,
): WeeklyReviewFindingEngineResult {
  return {
    companyId,
    periodStart,
    periodEnd,
    findings: [
      {
        stableId,
        category: stableId === "NSR-F04" ? "evidence_gap" : "decision_blocker",
        severity: stableId === "NSR-F04" ? "high" : "critical",
        status: "open",
        title,
        summary: `${title}.`,
        workstream: stableId === "NSR-F04" ? "Research & Insights" : "Operations",
        evidenceIds: ["issue:issue-1"],
        recommendedAction: { kind: "assign_owner" },
        recommendationText: "Take the recommended action.",
        reasonCode: "test_reason",
        sourceEntityType: "issue",
        sourceEntityId: "issue-1",
        confidence: "high",
        detectedAt: periodEnd,
        validationStatus: valid ? "valid" : "invalid",
        rulesTriggered: ["test_reason"],
        actorId: null,
        uiCta: { kind: "assign_owner" },
        metadata: {},
      },
    ],
    citations: valid
      ? [
          {
            findingStableId: stableId,
            companyId,
            citationType: "evidence",
            entityType: "issue",
            entityId: "issue-1",
            field: "description",
            label: "Issue citation",
            excerpt: "Cited same-company evidence.",
            metadata: {},
          },
        ]
      : [],
    recommendations: [
      {
        findingStableId: stableId,
        companyId,
        kind: stableId === "NSR-F04" ? "request_evidence" : "assign_owner",
        severity: stableId === "NSR-F04" ? "high" : "critical",
        title: "Take the recommended action.",
        rationale: `${title}.`,
        proposedAction: { citationRequired: true },
      },
    ],
    citationValidation: {
      valid,
      errors: valid ? [] : [{ code: "material_citation_missing", findingStableId: stableId }],
      materialFindingsWithoutCitations: valid ? [] : [stableId],
      invalidCitationIndexes: [],
    },
    adapterReadinessSummary: {
      byAdapterType: {} as never,
      byAgent: {},
    },
    modelAssuranceSummary: {
      byAgent: {},
    },
    inputCounts: {
      agents: 1,
      issues: 1,
      issueComments: 0,
      approvals: 0,
      heartbeatRuns: 0,
      budgetIncidents: 0,
      costEvents: 0,
      adapterReadinessProbes: 0,
    },
  };
}

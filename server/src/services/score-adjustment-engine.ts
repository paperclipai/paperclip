import type { Db } from "@paperclipai/db";
import { qualityScoreAdjustments, briefingQuality } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import type {
  BriefingQualityLabel,
  BriefingDimensionScore,
  BriefingGateResult,
  QualityScoreAdjustment,
  ScoreAdjustmentResult,
  ReReviewTriggerReason,
  EscalationLevel,
} from "@paperclipai/shared";
import { BRIEFING_MANDATORY_GATE_IDS, BRIEFING_QUALITY_DIMENSIONS } from "@paperclipai/shared";
import { briefingQualityService, assignQualityLabel } from "./briefing-quality.js";
import { reReviewQueueService } from "./re-review-queue.js";
import { crewRatingFlagsService } from "./crew-rating-flags.js";

const ADJUSTMENT_SOURCE = "crew_rating";
const OPERATIONAL_USEFULNESS_DIMENSION = "operational_usefulness";

const RATING_ADJUSTMENTS: Record<string, number> = {
  yes: 0.2,
  somewhat: 0,
  no: -0.3,
};

const TIER_BOUNDARIES: { min: number; label: BriefingQualityLabel }[] = [
  { min: 4.5, label: "premium" },
  { min: 3.5, label: "standard" },
  { min: 2.0, label: "degraded" },
  { min: 0, label: "failed" },
];

function labelForScore(score: number): BriefingQualityLabel {
  for (const boundary of TIER_BOUNDARIES) {
    if (score >= boundary.min) return boundary.label;
  }
  return "failed";
}

export function scoreAdjustmentEngine(db: Db) {
  const bqSvc = briefingQualityService(db);
  const reReviewSvc = reReviewQueueService(db);
  const crewFlagsSvc = crewRatingFlagsService(db);

  async function processRating(
    briefingId: string,
    userId: string,
    rating: string,
  ): Promise<ScoreAdjustmentResult> {
    const existing = await bqSvc.getByBriefingId(briefingId);
    const dimensionScores: BriefingDimensionScore[] = existing
      ? (existing.dimensionScores as BriefingDimensionScore[])
      : BRIEFING_QUALITY_DIMENSIONS.map((dim) => ({
          dimension: dim,
          score: 0,
          details: "no existing classification",
        }));
    const gateResults: BriefingGateResult[] = existing
      ? (existing.gateResults as BriefingGateResult[])
      : BRIEFING_MANDATORY_GATE_IDS.map((gid) => ({
          gateId: gid,
          dimension: "accuracy" as const,
          passed: true,
          details: "default pass — no classification run",
        }));

    const adjustmentAmount = RATING_ADJUSTMENTS[rating] ?? 0;

    const existingOpUsefulness = dimensionScores.find(
      (d) => d.dimension === OPERATIONAL_USEFULNESS_DIMENSION,
    );
    const previousOpScore = existingOpUsefulness?.score ?? 0;
    const newOpScore = Math.max(0, Math.min(5, previousOpScore + adjustmentAmount));

    const previousLabel: BriefingQualityLabel = existing?.label ?? "standard";
    const newLabel = labelForScore(newOpScore);
    const tierChanged = previousLabel !== newLabel;

    const updatedDimensionScores = dimensionScores.map((d) =>
      d.dimension === OPERATIONAL_USEFULNESS_DIMENSION
        ? { ...d, score: Math.round(newOpScore * 100) / 100 }
        : d,
    );

    const avgScore = updatedDimensionScores.reduce((s, d) => s + d.score, 0) / updatedDimensionScores.length;
    const overallScore = Math.round(avgScore * 100) / 100;

    const finalLabel = tierChanged
      ? newLabel
      : assignQualityLabel(overallScore, gateResults);

    await db
      .insert(briefingQuality)
      .values({
        briefingId,
        overallScore: overallScore.toString(),
        label: finalLabel,
        dimensionScores: JSON.stringify(updatedDimensionScores),
        gateResults: JSON.stringify(gateResults),
      })
      .onConflictDoUpdate({
        target: briefingQuality.briefingId,
        set: {
          overallScore: overallScore.toString(),
          label: finalLabel,
          dimensionScores: JSON.stringify(updatedDimensionScores),
          gateResults: JSON.stringify(gateResults),
          updatedAt: sql`now()`,
        },
      });

    let reReviewTrigger: ReReviewTriggerReason | null = null;
    let reReviewItem = null;
    let escalationLevel: EscalationLevel | null = null;

    if (rating === "no") {
      reReviewTrigger = "no_rating";
      const dueAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
      reReviewItem = await reReviewSvc.create(briefingId, userId, rating, "no_rating", dueAt);

      const noFlag = await crewFlagsSvc.incrementFlag(userId, "no");
      if (noFlag.thresholdMet) {
        reReviewTrigger = "investigation";
        const investigationDue = new Date(Date.now() + 24 * 60 * 60 * 1000);
        reReviewItem = await reReviewSvc.create(briefingId, userId, rating, "investigation", investigationDue);
      }
    }

    if (rating === "somewhat") {
      const somewhatFlag = await crewFlagsSvc.incrementFlag(userId, "somewhat");
      if (somewhatFlag.thresholdMet) {
        reReviewTrigger = "three_somewhat";
        const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        reReviewItem = await reReviewSvc.create(briefingId, userId, rating, "three_somewhat", dueAt);
      }
    }

    if (tierChanged || finalLabel === "failed" || finalLabel === "degraded") {
      escalationLevel = determineEscalation(finalLabel);
    }

    const [adjustment] = await db
      .insert(qualityScoreAdjustments)
      .values({
        briefingId,
        userId,
        rating,
        dimension: OPERATIONAL_USEFULNESS_DIMENSION,
        adjustmentAmount: adjustmentAmount.toString(),
        previousScore: previousOpScore.toString(),
        newScore: newOpScore.toString(),
        adjustmentSource: ADJUSTMENT_SOURCE,
        reReviewTriggered: reReviewTrigger,
        tierChanged: tierChanged ? `${previousLabel}->${finalLabel}` : null,
        escalationLevel,
      })
      .returning();

    return {
      adjustment: adjustment as unknown as QualityScoreAdjustment,
      previousLabel,
      newLabel: finalLabel,
      tierChanged,
      reReviewTriggered: reReviewTrigger,
      reReviewItem,
      escalationLevel,
    };
  }

  return { processRating };
}

function determineEscalation(label: BriefingQualityLabel): EscalationLevel | null {
  switch (label) {
    case "failed": return "critical";
    case "degraded": return "warning";
    default: return null;
  }
}

export type ScoreAdjustmentEngine = ReturnType<typeof scoreAdjustmentEngine>;

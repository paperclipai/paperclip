import type { Db } from "@paperclipai/db";
import { briefingQuality, qualityScoreAdjustments, reReviewQueue, briefingFeedback, authUsers } from "@paperclipai/db";
import { eq, sql, desc, and, gte, lte } from "drizzle-orm";
import type { QualityScorecard, QualityEscalation, QualityMetric, QualityMetricsResponse, BriefingQualityLabel, CrewMemberScore, GatePassRate } from "@paperclipai/shared";
import { BRIEFING_QUALITY_GATES } from "@paperclipai/shared";

export function qualityService(db: Db) {
  async function getScorecard(): Promise<QualityScorecard> {
    const rows = await db.select().from(briefingQuality).orderBy(desc(briefingQuality.createdAt)).limit(100);
    const totalClassified = rows.length;
    const labelCounts: Record<string, number> = { premium: 0, standard: 0, degraded: 0, failed: 0 };
    let scoreSum = 0;
    for (const row of rows) {
      labelCounts[row.label] = (labelCounts[row.label] ?? 0) + 1;
      scoreSum += parseFloat(row.overallScore);
    }
    const labelBreakdown = (Object.entries(labelCounts) as [string, number][]).map(([label, count]) => ({
      label: label as BriefingQualityLabel,
      count,
    }));
    const recentResults = rows.slice(0, 10).map((row) => ({
      briefingId: row.briefingId,
      overallScore: parseFloat(row.overallScore),
      label: row.label as BriefingQualityLabel,
      dimensionScores: row.dimensionScores as [],
      gateResults: row.gateResults as [],
      createdAt: row.createdAt,
    }));
    return {
      companyId: "",
      totalClassified,
      labelBreakdown,
      averageScore: totalClassified > 0 ? Math.round((scoreSum / totalClassified) * 100) / 100 : 0,
      recentResults,
    };
  }

  async function getEscalations(limit = 50): Promise<QualityEscalation[]> {
    const adjustments = await db
      .select({
        id: qualityScoreAdjustments.id,
        briefingId: qualityScoreAdjustments.briefingId,
        rating: qualityScoreAdjustments.rating,
        triggerReason: qualityScoreAdjustments.reReviewTriggered,
        status: sql<string>`'completed'`,
        escalationLevel: qualityScoreAdjustments.escalationLevel,
        createdAt: qualityScoreAdjustments.createdAt,
      })
      .from(qualityScoreAdjustments)
      .where(and(
        sql`${qualityScoreAdjustments.reReviewTriggered} is not null`,
        sql`${qualityScoreAdjustments.escalationLevel} is not null`,
      ))
      .orderBy(desc(qualityScoreAdjustments.createdAt))
      .limit(limit) as unknown as {
      id: string; briefingId: string; rating: string;
      triggerReason: string | null; status: string;
      escalationLevel: string | null; createdAt: Date;
    }[];
    const reReviews = await db
      .select({
        id: reReviewQueue.id,
        briefingId: reReviewQueue.briefingId,
        rating: reReviewQueue.rating,
        triggerReason: reReviewQueue.triggerReason,
        status: reReviewQueue.status,
        escalationLevel: sql<string | null>`NULL`,
        createdAt: reReviewQueue.createdAt,
      })
      .from(reReviewQueue)
      .orderBy(desc(reReviewQueue.createdAt))
      .limit(limit) as unknown as {
      id: string; briefingId: string; rating: string;
      triggerReason: string; status: string;
      escalationLevel: string | null; createdAt: Date;
    }[];
    const combined: QualityEscalation[] = [
      ...adjustments.map((a) => ({
        id: a.id,
        briefingId: a.briefingId,
        rating: a.rating,
        triggerReason: (a.triggerReason ?? "investigation") as QualityEscalation["triggerReason"],
        status: a.status as QualityEscalation["status"],
        escalationLevel: a.escalationLevel as QualityEscalation["escalationLevel"],
        createdAt: a.createdAt.toISOString(),
      })),
      ...reReviews.map((r) => ({
        id: r.id,
        briefingId: r.briefingId,
        rating: r.rating,
        triggerReason: r.triggerReason as QualityEscalation["triggerReason"],
        status: r.status as QualityEscalation["status"],
        escalationLevel: null,
        createdAt: r.createdAt.toISOString(),
      })),
    ];
    combined.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return combined.slice(0, limit);
  }

  async function getMetrics(days = 30): Promise<QualityMetricsResponse> {
    const now = new Date();
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const rows = await db
      .select()
      .from(briefingQuality)
      .where(gte(briefingQuality.createdAt, start))
      .orderBy(desc(briefingQuality.createdAt));
    const periodMap = new Map<string, { scores: number[]; labels: Record<string, number> }>();
    for (const row of rows) {
      const dateKey = row.createdAt.toISOString().slice(0, 10);
      if (!periodMap.has(dateKey)) {
        periodMap.set(dateKey, { scores: [], labels: {} });
      }
      const bucket = periodMap.get(dateKey)!;
      bucket.scores.push(parseFloat(row.overallScore));
      bucket.labels[row.label] = (bucket.labels[row.label] ?? 0) + 1;
    }
    const metrics: QualityMetric[] = Array.from(periodMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, data]) => ({
        period,
        averageScore: data.scores.length > 0
          ? Math.round((data.scores.reduce((s, v) => s + v, 0) / data.scores.length) * 100) / 100
          : 0,
        totalClassified: data.scores.length,
        labelCounts: data.labels,
      }));
    return { metrics };
  }

  async function getCrewScores(): Promise<CrewMemberScore[]> {
    const rows = await db
      .select({
        userId: briefingFeedback.userId,
        userName: authUsers.name,
        userImage: authUsers.image,
        overallScore: briefingQuality.overallScore,
        dimensionScores: briefingQuality.dimensionScores,
        createdAt: briefingQuality.createdAt,
      })
      .from(briefingQuality)
      .innerJoin(briefingFeedback, eq(briefingQuality.briefingId, briefingFeedback.briefingId))
      .innerJoin(authUsers, eq(briefingFeedback.userId, authUsers.id))
      .orderBy(desc(briefingQuality.createdAt));

    const userMap = new Map<string, {
      name: string; image: string | null;
      scores: number[]; accScores: number[]; timeScores: number[]; compScores: number[];
      recentDates: Date[]; allDates: Date[];
    }>();

    for (const row of rows) {
      const uid = row.userId;
      if (!userMap.has(uid)) {
        userMap.set(uid, { name: row.userName, image: row.userImage, scores: [], accScores: [], timeScores: [], compScores: [], recentDates: [], allDates: [] });
      }
      const u = userMap.get(uid)!;
      u.scores.push(parseFloat(row.overallScore));
      u.allDates.push(row.createdAt);

      const dims = (row.dimensionScores ?? []) as { dimension: string; score: number }[];
      for (const d of dims) {
        if (d.dimension === "accuracy") u.accScores.push(d.score);
        if (d.dimension === "timeliness") u.timeScores.push(d.score);
        if (d.dimension === "completeness") u.compScores.push(d.score);
      }
    }
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;

    const result: CrewMemberScore[] = [];
    for (const [uid, u] of userMap) {
      const avg = (arr: number[]) => arr.length > 0 ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10 : 0;
      const overall = avg(u.scores);
      const recentCutoff = new Date(now - sevenDays);
      const recentCount = u.allDates.filter(d => d >= recentCutoff).length;
      const prevCount = u.allDates.filter(d => d < recentCutoff && d >= new Date(now - 2 * sevenDays)).length;
      const trend: "up" | "down" | "stable" = recentCount > prevCount + 1 ? "up" : prevCount > recentCount + 1 ? "down" : "stable";

      result.push({
        id: uid,
        name: u.name,
        image: u.image,
        overall,
        accuracy: avg(u.accScores),
        timeliness: avg(u.timeScores),
        completeness: avg(u.compScores),
        trend,
        totalBriefings: u.scores.length,
      });
    }
    result.sort((a, b) => b.overall - a.overall);
    return result;
  }

  async function getGatePassRates(): Promise<GatePassRate[]> {
    const rows = await db.select({ gateResults: briefingQuality.gateResults }).from(briefingQuality);
    const gateMap = new Map<string, { passed: number; failed: number }>();
    for (const row of rows) {
      const gates = (row.gateResults ?? []) as { gateId: string; passed: boolean }[];
      for (const g of gates) {
        if (!gateMap.has(g.gateId)) gateMap.set(g.gateId, { passed: 0, failed: 0 });
        const entry = gateMap.get(g.gateId)!;
        if (g.passed) entry.passed++;
        else entry.failed++;
      }
    }
    const gateDefs = new Map(BRIEFING_QUALITY_GATES.map((g) => [g.id, g.description]));
    return Array.from(gateMap.entries())
      .map(([gateId, counts]) => ({
        gate: gateId,
        description: gateDefs.get(gateId) ?? gateId,
        passed: counts.passed,
        failed: counts.failed,
        total: counts.passed + counts.failed,
      }))
      .sort((a, b) => a.gate.localeCompare(b.gate));
  }

  return { getScorecard, getEscalations, getMetrics, getCrewScores, getGatePassRates };
}

export type QualityService = ReturnType<typeof qualityService>;

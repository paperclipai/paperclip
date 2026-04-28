import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, issues, rt2V33TaskProfiles, rt2QualityScores } from "@paperclipai/db";

export function rt2CollaborationService(_db: Db) {
  return {
    getTeamHealth: async (companyId: string, projectId: string) => {
      return {
        companyId,
        projectId,
        collaborationScore: 0,
        communicationFrequency: 0,
        blockerResolutionTime: null,
      };
    },

    getCrossTeamDependencies: async (companyId: string) => {
      return {
        companyId,
        dependencies: [],
      };
    },

    getWorkloadBalance: async (companyId: string, projectId: string) => {
      return {
        companyId,
        projectId,
        byAgent: {},
        balanced: true,
      };
    },
  };
}

export function rt2QualityService(db: Db) {
  return {
    getQualityMetrics: async (companyId: string, projectId: string) => {
      // Get all work products for this project
      const workProducts = await db
        .select()
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.projectId, projectId),
          ),
        );

      if (workProducts.length === 0) {
        return {
          companyId,
          projectId,
          defectRate: 0,
          reviewCycleTime: null,
          qualityScore: 0,
          codeReviewCoverage: 0,
        };
      }

      // Calculate defect rate (rejected / total)
      const rejectedCount = workProducts.filter(
        (wp) => wp.reviewState === "rejected",
      ).length;
      const defectRate = Math.round((rejectedCount / workProducts.length) * 100 * 10) / 10;

      // Calculate code review coverage (reviewed / total)
      const reviewedCount = workProducts.filter(
        (wp) => wp.reviewState !== "none",
      ).length;
      const codeReviewCoverage = Math.round(
        (reviewedCount / workProducts.length) * 100,
      );

      // Calculate average review cycle time (from createdAt to first review state change)
      const workProductsWithReviewTime = workProducts.filter(
        (wp) => wp.reviewState !== "none" && wp.updatedAt,
      );
      let reviewCycleTime: number | null = null;
      if (workProductsWithReviewTime.length > 0) {
        const totalCycleMs = workProductsWithReviewTime.reduce((sum, wp) => {
          const created = new Date(wp.createdAt).getTime();
          const updated = new Date(wp.updatedAt).getTime();
          return sum + (updated - created);
        }, 0);
        reviewCycleTime = Math.round(totalCycleMs / workProductsWithReviewTime.length / (1000 * 60 * 60)); // hours
      }

      // Calculate overall quality score (shadow mode: positive only)
      // reviewed and not rejected = good quality
      const goodCount = workProducts.filter(
        (wp) => wp.reviewState === "approved",
      ).length;
      const qualityScore = Math.round((goodCount / workProducts.length) * 100);

      return {
        companyId,
        projectId,
        defectRate,
        reviewCycleTime,
        qualityScore,
        codeReviewCoverage,
      };
    },

    getQualityTrends: async (companyId: string, projectId: string) => {
      // Get work products from last 14 days grouped by date
      const fourteenDaysAgo = new Date();
      fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

      const workProducts = await db
        .select()
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.projectId, projectId),
          ),
        );

      if (workProducts.length === 0) {
        return {
          companyId,
          projectId,
          dataPoints: [],
          trend: "stable",
        };
      }

      // Group by date
      const byDate = new Map<string, typeof workProducts>();
      for (const wp of workProducts) {
        const date = new Date(wp.createdAt).toISOString().split("T")[0];
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date)!.push(wp);
      }

      // Build data points
      const dataPoints = Array.from(byDate.entries())
        .map(([date, products]) => {
          const total = products.length;
          const rejected = products.filter((p) => p.reviewState === "rejected").length;
          const reviewed = products.filter((p) => p.reviewState !== "none").length;

          return {
            date,
            defectRate: total > 0 ? Math.round((rejected / total) * 100 * 10) / 10 : 0,
            reviewCoverage: total > 0 ? Math.round((reviewed / total) * 100) : 0,
            totalDeliverables: total,
          };
        })
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-14); // last 14 days

      // Determine trend
      let trend: "improving" | "stable" | "declining" = "stable";
      if (dataPoints.length >= 3) {
        const recent = dataPoints.slice(-3).reduce((sum, d) => sum + d.defectRate, 0) / 3;
        const earlier = dataPoints.slice(0, 3).reduce((sum, d) => sum + d.defectRate, 0) / 3;
        if (recent < earlier - 1) trend = "improving";
        else if (recent > earlier + 1) trend = "declining";
      }

      return {
        companyId,
        projectId,
        dataPoints,
        trend,
      };
    },

    getQualityGateStatus: async (companyId: string, projectId: string) => {
      // Define quality gates
      const gates = [
        {
          id: "review_coverage",
          name: "Review Coverage",
          threshold: 80,
          metric: "codeReviewCoverage" as const,
        },
        {
          id: "defect_rate",
          name: "Defect Rate",
          threshold: 5,
          metric: "defectRate" as const,
        },
        {
          id: "quality_score",
          name: "Quality Score",
          threshold: 70,
          metric: "qualityScore" as const,
        },
      ];

      // Get current metrics
      const metrics = await db
        .select({
          reviewed: sql<number>`COUNT(*) FILTER (WHERE ${issueWorkProducts.reviewState} != 'none')`,
          total: sql<number>`COUNT(*)`,
          rejected: sql<number>`COUNT(*) FILTER (WHERE ${issueWorkProducts.reviewState} = 'rejected')`,
          approved: sql<number>`COUNT(*) FILTER (WHERE ${issueWorkProducts.reviewState} = 'approved')`,
        })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.projectId, projectId),
          ),
        )
        .then((rows) => rows[0] ?? { reviewed: 0, total: 0, rejected: 0, approved: 0 });

      const codeReviewCoverage = metrics.total > 0
        ? Math.round((Number(metrics.reviewed) / Number(metrics.total)) * 100)
        : 0;
      const defectRate = metrics.total > 0
        ? Math.round((Number(metrics.rejected) / Number(metrics.total)) * 100 * 10) / 10
        : 0;
      const qualityScore = metrics.total > 0
        ? Math.round((Number(metrics.approved) / Number(metrics.total)) * 100)
        : 0;

      const evaluatedGates = gates.map((gate) => {
        const currentValue =
          gate.metric === "codeReviewCoverage"
            ? codeReviewCoverage
            : gate.metric === "defectRate"
              ? defectRate
              : qualityScore;

        // For defect rate, lower is better; for others, higher is better
        let status: "passing" | "failing" | "warning";
        if (gate.id === "defect_rate") {
          if (currentValue <= gate.threshold) status = "passing";
          else if (currentValue <= gate.threshold * 1.5) status = "warning";
          else status = "failing";
        } else {
          if (currentValue >= gate.threshold) status = "passing";
          else if (currentValue >= gate.threshold * 0.8) status = "warning";
          else status = "failing";
        }

        return {
          id: gate.id,
          name: gate.name,
          status,
          threshold: gate.threshold,
          currentValue,
        };
      });

      const overallPassing = evaluatedGates.every((g) => g.status !== "failing");

      return {
        companyId,
        projectId,
        gates: evaluatedGates,
        overallPassing,
      };
    },

    recordQualityScore: async (
      companyId: string,
      data: {
        deliverableId?: string;
        taskIssueId: string;
        evaluator: string;
        evalType: string;
        score: number;
        category: string;
        rationale?: string;
      },
    ) => {
      // Shadow mode: positive scores are active (isActive=1), negative scores are shadow-only (isActive=0)
      const isActive = data.score >= 0 ? 1 : 0;
      const direction = data.score >= 0 ? "positive" : "negative";

      const [record] = await db
        .insert(rt2QualityScores)
        .values({
          companyId,
          deliverableId: data.deliverableId || null,
          taskIssueId: data.taskIssueId,
          evaluator: data.evaluator,
          evalType: data.evalType,
          score: data.score,
          direction,
          category: data.category,
          rationale: data.rationale || null,
          isActive,
        })
        .returning();

      return {
        id: record.id,
        companyId,
        deliverableId: record.deliverableId,
        taskIssueId: record.taskIssueId,
        evaluator: record.evaluator,
        evalType: record.evalType,
        score: record.score,
        direction: record.direction,
        category: record.category,
        rationale: record.rationale,
        isActive: record.isActive === 1,
        createdAt: record.createdAt,
      };
    },

    getQualityScores: async (
      companyId: string,
      filters: { taskIssueId?: string; deliverableId?: string },
    ) => {
      const conditions = [eq(rt2QualityScores.companyId, companyId)];
      if (filters.taskIssueId) {
        conditions.push(eq(rt2QualityScores.taskIssueId, filters.taskIssueId));
      }
      if (filters.deliverableId) {
        conditions.push(eq(rt2QualityScores.deliverableId, filters.deliverableId));
      }

      const scores = await db
        .select()
        .from(rt2QualityScores)
        .where(and(...conditions))
        .orderBy(rt2QualityScores.createdAt);

      return scores.map((s) => ({
        id: s.id,
        companyId: s.companyId,
        deliverableId: s.deliverableId,
        taskIssueId: s.taskIssueId,
        evaluator: s.evaluator,
        evalType: s.evalType,
        score: s.score,
        direction: s.direction,
        category: s.category,
        rationale: s.rationale,
        isActive: s.isActive === 1,
        createdAt: s.createdAt,
      }));
    },

    getQualitySummary: async (companyId: string, projectId: string) => {
      // Get all tasks for this project
      const taskProfiles = await db
        .select({ issueId: rt2V33TaskProfiles.issueId })
        .from(rt2V33TaskProfiles)
        .where(
          and(
            eq(rt2V33TaskProfiles.companyId, companyId),
            eq(rt2V33TaskProfiles.projectId, projectId),
          ),
        );

      const taskIssueIds = taskProfiles.map((p) => p.issueId);
      if (taskIssueIds.length === 0) {
        return {
          companyId,
          projectId,
          totalScores: 0,
          activeScores: 0,
          shadowScores: 0,
          positiveScores: 0,
          negativeScores: 0,
          averageScore: 0,
          byCategory: {},
          byEvaluator: {},
        };
      }

      // Get all quality scores for these tasks
      const conditions = [eq(rt2QualityScores.companyId, companyId)];
      conditions.push(
        sql`${rt2QualityScores.taskIssueId} IN (${sql.join(taskIssueIds.map((id) => sql`${id}`), sql`, `)})`,
      );

      const scores = await db
        .select()
        .from(rt2QualityScores)
        .where(and(...conditions));

      if (scores.length === 0) {
        return {
          companyId,
          projectId,
          totalScores: 0,
          activeScores: 0,
          shadowScores: 0,
          positiveScores: 0,
          negativeScores: 0,
          averageScore: 0,
          byCategory: {},
          byEvaluator: {},
        };
      }

      // Calculate summary stats
      const activeScores = scores.filter((s) => s.isActive === 1);
      const shadowScores = scores.filter((s) => s.isActive === 0);
      const positiveScores = scores.filter((s) => s.direction === "positive");
      const negativeScores = scores.filter((s) => s.direction === "negative");

      // Average score (using only active/positive scores per shadow mode)
      const totalActiveScore = activeScores.reduce((sum, s) => sum + s.score, 0);
      const averageScore = activeScores.length > 0
        ? Math.round(totalActiveScore / activeScores.length)
        : 0;

      // Group by category
      const byCategory: Record<string, { count: number; avgScore: number }> = {};
      for (const s of activeScores) {
        if (!byCategory[s.category]) {
          byCategory[s.category] = { count: 0, avgScore: 0 };
        }
        byCategory[s.category].count++;
        byCategory[s.category].avgScore += s.score;
      }
      for (const cat of Object.keys(byCategory)) {
        byCategory[cat].avgScore = Math.round(byCategory[cat].avgScore / byCategory[cat].count);
      }

      // Group by evaluator
      const byEvaluator: Record<string, { count: number; avgScore: number }> = {};
      for (const s of activeScores) {
        if (!byEvaluator[s.evaluator]) {
          byEvaluator[s.evaluator] = { count: 0, avgScore: 0 };
        }
        byEvaluator[s.evaluator].count++;
        byEvaluator[s.evaluator].avgScore += s.score;
      }
      for (const evalKey of Object.keys(byEvaluator)) {
        byEvaluator[evalKey].avgScore = Math.round(byEvaluator[evalKey].avgScore / byEvaluator[evalKey].count);
      }

      return {
        companyId,
        projectId,
        totalScores: scores.length,
        activeScores: activeScores.length,
        shadowScores: shadowScores.length,
        positiveScores: positiveScores.length,
        negativeScores: negativeScores.length,
        averageScore,
        byCategory,
        byEvaluator,
      };
    },
  };
}
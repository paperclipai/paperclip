import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { rt2QualityScores } from "@paperclipai/db";

export type CoPilotEvaluation = {
  id: string;
  companyId: string;
  deliverableId: string | null;
  taskIssueId: string;
  evaluator: string;
  evalType: string;
  score: number;
  direction: "positive" | "negative";
  category: string;
  rationale: string | null;
  isActive: number;
  managerDecision: "approved" | "rejected" | "pending" | null;
  managerId: string | null;
  managerFeedback: string | null;
  isFinalized: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CoPilotPendingReview = {
  evaluationId: string;
  taskTitle: string;
  evaluator: string;
  score: number;
  direction: string;
  category: string;
  rationale: string | null;
  createdAt: Date;
};

export type CoPilotFeedbackSummary = {
  totalEvaluations: number;
  approved: number;
  rejected: number;
  pending: number;
  approvalRate: number;
  topRejectionReasons: { reason: string; count: number }[];
};

export function rt2CoPilotService(db: Db) {
  /**
   * M3.1: Create AI preliminary evaluation
   */
  async function createPreliminaryEvaluation(
    companyId: string,
    taskIssueId: string,
    evaluator: string,
    score: number,
    category: string,
    rationale: string,
    direction: "positive" | "negative" = "positive",
  ): Promise<CoPilotEvaluation> {
    const [eval_] = await db
      .insert(rt2QualityScores)
      .values({
        companyId,
        taskIssueId,
        evaluator,
        evalType: "ai_preliminary",
        score,
        category,
        rationale,
        direction,
        isActive: 0, // In Co-Pilot, evaluations start as pending
        managerDecision: "pending",
        isFinalized: 0,
      })
      .returning();

    return eval_ as unknown as CoPilotEvaluation;
  }

  /**
   * M3.1: Get all pending evaluations for manager review
   */
  async function getPendingEvaluations(companyId: string): Promise<CoPilotPendingReview[]> {
    const pending = await db
      .select()
      .from(rt2QualityScores)
      .where(
        and(
          eq(rt2QualityScores.companyId, companyId),
          eq(rt2QualityScores.isFinalized, 0),
          eq(rt2QualityScores.managerDecision, "pending"),
        ),
      )
      .orderBy(desc(rt2QualityScores.createdAt));

    return pending.map(p => ({
      evaluationId: p.id,
      taskTitle: "", // Would need to join with issues table
      evaluator: p.evaluator,
      score: p.score,
      direction: p.direction,
      category: p.category,
      rationale: p.rationale,
      createdAt: p.createdAt,
    })) as CoPilotPendingReview[];
  }

  /**
   * M3.1: Manager approves evaluation
   */
  async function approveEvaluation(
    evaluationId: string,
    companyId: string,
    managerId: string,
    feedback?: string,
  ): Promise<CoPilotEvaluation> {
    const [updated] = await db
      .update(rt2QualityScores)
      .set({
        managerDecision: "approved",
        managerId,
        managerFeedback: feedback || null,
        isActive: 1, // Activate the score
        isFinalized: 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(rt2QualityScores.id, evaluationId),
          eq(rt2QualityScores.companyId, companyId),
        ),
      )
      .returning();

    return updated as unknown as CoPilotEvaluation;
  }

  /**
   * M3.1: Manager rejects evaluation
   */
  async function rejectEvaluation(
    evaluationId: string,
    companyId: string,
    managerId: string,
    feedback: string,
  ): Promise<CoPilotEvaluation> {
    const [updated] = await db
      .update(rt2QualityScores)
      .set({
        managerDecision: "rejected",
        managerId,
        managerFeedback: feedback,
        isActive: 0, // Don't activate
        isFinalized: 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(rt2QualityScores.id, evaluationId),
          eq(rt2QualityScores.companyId, companyId),
        ),
      )
      .returning();

    return updated as unknown as CoPilotEvaluation;
  }

  /**
   * M3.1: Get finalized evaluations for a deliverable
   */
  async function getFinalizedEvaluations(
    companyId: string,
    deliverableId: string,
  ): Promise<CoPilotEvaluation[]> {
    const evals = await db
      .select()
      .from(rt2QualityScores)
      .where(
        and(
          eq(rt2QualityScores.companyId, companyId),
          eq(rt2QualityScores.deliverableId, deliverableId),
          eq(rt2QualityScores.isFinalized, 1),
        ),
      )
      .orderBy(desc(rt2QualityScores.createdAt));

    return evals.map(e => ({
      ...e,
      managerDecision: e.managerDecision as "approved" | "rejected" | "pending" | null,
    })) as CoPilotEvaluation[];
  }

  /**
   * M3.1: Get feedback summary for learning
   */
  async function getFeedbackSummary(
    companyId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<CoPilotFeedbackSummary> {
    const conditions = [
      eq(rt2QualityScores.companyId, companyId),
      eq(rt2QualityScores.isFinalized, 1),
    ];

    if (startDate) {
      conditions.push(gte(rt2QualityScores.createdAt, new Date(startDate)));
    }
    if (endDate) {
      conditions.push(lte(rt2QualityScores.createdAt, new Date(endDate)));
    }

    const evals = await db
      .select()
      .from(rt2QualityScores)
      .where(and(...conditions));

    const approved = evals.filter(e => e.managerDecision === "approved").length;
    const rejected = evals.filter(e => e.managerDecision === "rejected").length;
    const pending = evals.filter(e => e.managerDecision === "pending").length;

    // Analyze rejection reasons
    const rejectionReasons = new Map<string, number>();
    for (const eval_ of evals) {
      if (eval_.managerDecision === "rejected" && eval_.managerFeedback) {
        // Extract key phrases from feedback (simplified)
        const reason = eval_.managerFeedback.substring(0, 50);
        rejectionReasons.set(reason, (rejectionReasons.get(reason) || 0) + 1);
      }
    }

    const topRejectionReasons = [...rejectionReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));

    return {
      totalEvaluations: evals.length,
      approved,
      rejected,
      pending,
      approvalRate: evals.length > 0 ? Math.round((approved / evals.length) * 100) : 0,
      topRejectionReasons,
    };
  }

  /**
   * M3.1: Get evaluation with AI rationale report
   */
  async function getAIRationaleReport(
    companyId: string,
    taskIssueId: string,
  ): Promise<{
    taskIssueId: string;
    evaluations: CoPilotEvaluation[];
    summary: string;
    recommendations: string[];
  }> {
    const evals = await db
      .select()
      .from(rt2QualityScores)
      .where(
        and(
          eq(rt2QualityScores.companyId, companyId),
          eq(rt2QualityScores.taskIssueId, taskIssueId),
        ),
      )
      .orderBy(desc(rt2QualityScores.createdAt));

    const evaluations = evals.map(e => ({
      ...e,
      managerDecision: e.managerDecision as "approved" | "rejected" | "pending" | null,
    })) as CoPilotEvaluation[];

    // Generate summary
    const approvedCount = evaluations.filter(e => e.managerDecision === "approved").length;
    const rejectedCount = evaluations.filter(e => e.managerDecision === "rejected").length;
    const avgScore = evaluations.length > 0
      ? Math.round(evaluations.reduce((sum, e) => sum + e.score, 0) / evaluations.length)
      : 0;

    const summary = `AI evaluated this task ${evaluations.length} times. ${approvedCount} approved, ${rejectedCount} rejected. Average score: ${avgScore}/100.`;

    // Generate recommendations based on rejection reasons
    const recommendations: string[] = [];
    const rejectedEvals = evaluations.filter(e => e.managerDecision === "rejected");
    if (rejectedEvals.length > 0) {
      recommendations.push("Review rejected evaluations for common patterns.");
    }
    if (avgScore < 70) {
      recommendations.push("Consider additional validation before submission.");
    }
    if (rejectedEvals.some(e => e.category === "accuracy")) {
      recommendations.push("Focus on improving accuracy metrics.");
    }
    if (rejectedEvals.some(e => e.category === "completeness")) {
      recommendations.push("Ensure all required components are included.");
    }

    return {
      taskIssueId,
      evaluations,
      summary,
      recommendations,
    };
  }

  /**
   * M3.1: Batch approve pending evaluations
   */
  async function batchApprove(
    evaluationIds: string[],
    companyId: string,
    managerId: string,
    feedback?: string,
  ): Promise<number> {
    const [result] = await db
      .update(rt2QualityScores)
      .set({
        managerDecision: "approved",
        managerId,
        managerFeedback: feedback || null,
        isActive: 1,
        isFinalized: 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(rt2QualityScores.companyId, companyId),
          eq(rt2QualityScores.isFinalized, 0),
        ),
      )
      .returning();

    return result ? 1 : 0;
  }

  return {
    createPreliminaryEvaluation,
    getPendingEvaluations,
    approveEvaluation,
    rejectEvaluation,
    getFinalizedEvaluations,
    getFeedbackSummary,
    getAIRationaleReport,
    batchApprove,
  };
}

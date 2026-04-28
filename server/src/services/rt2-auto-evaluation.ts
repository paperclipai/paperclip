import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueWorkProducts,
  issues,
  rt2BasePrices,
  rt2QualityScores,
  DEFAULT_BASE_PRICES,
} from "@paperclipai/db";
import { rt2GamificationXpTransactions, rt2GamificationAgentBalances } from "@paperclipai/db";
import type {
  Rt2JarvisAutoPolicyDecision,
  Rt2JarvisPolicyDecision,
  Rt2JarvisQualityReviewQueue,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

// ============================================================================
// Types
// ============================================================================

export type BasePrice = {
  id: string;
  companyId: string;
  deliverableType: string;
  basePrice: number;
  autoApproveThreshold: number;
  isActive: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AutoEvaluation = {
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
  basePrice: number | null;
  autoApprovalBandLow: number | null;
  autoApprovalBandHigh: number | null;
  evaluationMode: "shadow" | "auto" | "copilot" | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AutoEvaluationResult = {
  evaluation: AutoEvaluation;
  expectedScore: number;
  isWithinBand: boolean;
  autoApproved: boolean;
  policyDecision: Rt2JarvisAutoPolicyDecision;
};

export type AutoEvaluationStats = {
  totalEvaluations: number;
  autoApproved: number;
  copilotPending: number;
  autoApprovalRate: number;
  averageScore: number;
  byDeliverableType: Record<string, {
    count: number;
    autoApproved: number;
    copilotPending: number;
  }>;
};

// ============================================================================
// Service
// ============================================================================

export function rt2AutoEvaluationService(db: Db) {
  /**
   * M4.1: Get base price for a deliverable type
   * Returns default if not found
   */
  async function getBasePrice(
    companyId: string,
    deliverableType: string,
  ): Promise<{ basePrice: number; threshold: number; source: "custom" | "default" }> {
    const existing = await db
      .select()
      .from(rt2BasePrices)
      .where(
        and(
          eq(rt2BasePrices.companyId, companyId),
          eq(rt2BasePrices.deliverableType, deliverableType),
          eq(rt2BasePrices.isActive, 1),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      return {
        basePrice: existing.basePrice,
        threshold: existing.autoApproveThreshold,
        source: "custom",
      };
    }

    // Return default
    const defaultPrice = DEFAULT_BASE_PRICES[deliverableType] ?? DEFAULT_BASE_PRICES["default"];
    return {
      basePrice: defaultPrice,
      threshold: 0.1, // ±10%
      source: "default",
    };
  }

  /**
   * M4.1: Set base price for a deliverable type
   */
  async function setBasePrice(
    companyId: string,
    deliverableType: string,
    basePrice: number,
    threshold: number = 0.1,
  ): Promise<BasePrice> {
    const existing = await db
      .select()
      .from(rt2BasePrices)
      .where(
        and(
          eq(rt2BasePrices.companyId, companyId),
          eq(rt2BasePrices.deliverableType, deliverableType),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      const [updated] = await db
        .update(rt2BasePrices)
        .set({
          basePrice,
          autoApproveThreshold: threshold,
          isActive: 1,
          updatedAt: new Date(),
        })
        .where(eq(rt2BasePrices.id, existing.id))
        .returning();
      return updated as BasePrice;
    }

    const [created] = await db
      .insert(rt2BasePrices)
      .values({
        companyId,
        deliverableType,
        basePrice,
        autoApproveThreshold: threshold,
        isActive: 1,
      })
      .returning();

    return created as BasePrice;
  }

  /**
   * M4.1: Delete base price (soft delete)
   */
  async function deleteBasePrice(
    companyId: string,
    deliverableType: string,
  ): Promise<void> {
    await db
      .update(rt2BasePrices)
      .set({
        isActive: 0,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(rt2BasePrices.companyId, companyId),
          eq(rt2BasePrices.deliverableType, deliverableType),
        ),
      );
  }

  /**
   * M4.1: List all base prices for a company
   */
  async function listBasePrices(companyId: string): Promise<BasePrice[]> {
    return db
      .select()
      .from(rt2BasePrices)
      .where(
        and(
          eq(rt2BasePrices.companyId, companyId),
          eq(rt2BasePrices.isActive, 1),
        ),
      )
      .orderBy(rt2BasePrices.deliverableType) as Promise<BasePrice[]>;
  }

  /**
   * M4.1: Update threshold for a specific base price
   */
  async function updateThreshold(
    companyId: string,
    deliverableType: string,
    threshold: number,
  ): Promise<BasePrice> {
    const existing = await db
      .select()
      .from(rt2BasePrices)
      .where(
        and(
          eq(rt2BasePrices.companyId, companyId),
          eq(rt2BasePrices.deliverableType, deliverableType),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!existing) {
      throw notFound(`Base price for ${deliverableType} not found`);
    }

    const [updated] = await db
      .update(rt2BasePrices)
      .set({
        autoApproveThreshold: threshold,
        updatedAt: new Date(),
      })
      .where(eq(rt2BasePrices.id, existing.id))
      .returning();

    return updated as BasePrice;
  }

  /**
   * M4.1: Core auto-evaluation logic
   *
   * Determines if an AI evaluation score falls within the auto-approval band.
   * If within ±threshold of basePrice, auto-approves.
   * Otherwise, escalates to Co-Pilot mode for manager review.
   */
  async function evaluateDeliverable(
    companyId: string,
    taskIssueId: string,
    aiScore: number, // 0-100
    deliverableType: string,
    evaluator: string = "ai_auto",
    rationale?: string,
    mode: "shadow" | "copilot" | "auto" = "auto",
  ): Promise<AutoEvaluationResult> {
    const policy = await decideAutoPolicy(companyId, aiScore, deliverableType, mode);
    if (mode === "shadow") {
      return createShadowEvaluation(companyId, taskIssueId, aiScore, evaluator, rationale, policy);
    }
    if (mode === "copilot") {
      return createCopilotEvaluation(
        companyId,
        taskIssueId,
        aiScore,
        evaluator,
        rationale,
        "Co-Pilot mode requires manager approval before the score becomes active",
        policy,
      );
    }

    // Edge cases: 0 or negative scores always go to Co-Pilot
    if (aiScore <= 0) {
      return createCopilotEvaluation(
        companyId,
        taskIssueId,
        aiScore,
        evaluator,
        rationale,
        "Invalid score - must be positive",
        policy,
      );
    }

    // Get base price
    const { basePrice, threshold, source } = await getBasePrice(companyId, deliverableType);

    // Calculate expected score (in gold units)
    const expectedScore = Math.round(basePrice * (aiScore / 100));

    // Calculate approval band
    const bandLow = Math.round(basePrice * (1 - threshold));
    const bandHigh = Math.round(basePrice * (1 + threshold));

    // Determine if within band
    const isWithinBand = expectedScore >= bandLow && expectedScore <= bandHigh;

    if (isWithinBand) {
      // Auto-approve
      return createAutoApprovedEvaluation(
        companyId,
        taskIssueId,
        aiScore,
        evaluator,
        rationale,
        basePrice,
        bandLow,
        bandHigh,
        source,
        policy,
      );
    } else {
      // Escalate to Co-Pilot
      return createCopilotEvaluation(
        companyId,
        taskIssueId,
        aiScore,
        evaluator,
        rationale,
        `Score ${expectedScore}g outside band [${bandLow}g, ${bandHigh}g] - requires manager review`,
        policy,
      );
    }
  }

  async function decideAutoPolicy(
    companyId: string,
    aiScore: number,
    deliverableType: string,
    requestedMode: "shadow" | "copilot" | "auto" = "auto",
  ): Promise<Rt2JarvisAutoPolicyDecision> {
    const { basePrice, threshold, source } = await getBasePrice(companyId, deliverableType);
    const expectedDeltaGold = Math.round(basePrice * (aiScore / 100));
    const bandLow = Math.round(basePrice * (1 - threshold));
    const bandHigh = Math.round(basePrice * (1 + threshold));

    if (requestedMode === "shadow") {
      return {
        mode: "shadow",
        decision: "record_only",
        reason: "Shadow mode records evaluation evidence without activating the score.",
        expectedDeltaGold,
        basePrice,
        bandLow,
        bandHigh,
        threshold,
        thresholdSource: source,
        approvalRequired: false,
      };
    }

    if (requestedMode === "copilot" || aiScore <= 0 || expectedDeltaGold < bandLow || expectedDeltaGold > bandHigh) {
      return {
        mode: "copilot",
        decision: "requires_copilot",
        reason: requestedMode === "copilot"
          ? "Co-Pilot mode requires manager approval before activation."
          : `Expected delta ${expectedDeltaGold}g is outside policy band [${bandLow}g, ${bandHigh}g].`,
        expectedDeltaGold,
        basePrice,
        bandLow,
        bandHigh,
        threshold,
        thresholdSource: source,
        approvalRequired: true,
      };
    }

    return {
      mode: "auto",
      decision: "auto_approved",
      reason: `Expected delta ${expectedDeltaGold}g is within policy band [${bandLow}g, ${bandHigh}g].`,
      expectedDeltaGold,
      basePrice,
      bandLow,
      bandHigh,
      threshold,
      thresholdSource: source,
      approvalRequired: false,
    };
  }

  /**
   * Helper: Create auto-approved evaluation
   */
  async function createAutoApprovedEvaluation(
    companyId: string,
    taskIssueId: string,
    aiScore: number,
    evaluator: string,
    rationale: string | undefined,
    basePrice: number,
    bandLow: number,
    bandHigh: number,
    _source: "custom" | "default",
    policyDecision: Rt2JarvisAutoPolicyDecision,
  ): Promise<AutoEvaluationResult> {
    const expectedScore = Math.round(basePrice * (aiScore / 100));

    const [evaluation] = await db
      .insert(rt2QualityScores)
      .values({
        companyId,
        taskIssueId,
        evaluator,
        evalType: "ai_auto",
        score: aiScore,
        direction: "positive",
        category: "auto_evaluated",
        rationale: rationale || `Auto-approved: score ${expectedScore}g within band [${bandLow}g, ${bandHigh}g]`,
        isActive: 1,
        managerDecision: "approved",
        managerId: "system",
        managerFeedback: "Auto-approved by M4.1 system",
        isFinalized: 1,
        basePrice,
        autoApprovalBandLow: bandLow,
        autoApprovalBandHigh: bandHigh,
        evaluationMode: "auto",
      })
      .returning();

    return {
      evaluation: evaluation as AutoEvaluation,
      expectedScore,
      isWithinBand: true,
      autoApproved: true,
      policyDecision,
    };
  }

  async function createShadowEvaluation(
    companyId: string,
    taskIssueId: string,
    aiScore: number,
    evaluator: string,
    rationale: string | undefined,
    policyDecision: Rt2JarvisAutoPolicyDecision,
  ): Promise<AutoEvaluationResult> {
    const [evaluation] = await db
      .insert(rt2QualityScores)
      .values({
        companyId,
        taskIssueId,
        evaluator,
        evalType: "ai_shadow",
        score: aiScore,
        direction: aiScore >= 50 ? "positive" : "negative",
        category: "shadow_evaluated",
        rationale: rationale || "Shadow evaluation recorded as evidence only",
        isActive: 0,
        managerDecision: null,
        isFinalized: 0,
        evaluationMode: "shadow",
      })
      .returning();

    return {
      evaluation: evaluation as AutoEvaluation,
      expectedScore: 0,
      isWithinBand: false,
      autoApproved: false,
      policyDecision,
    };
  }

  /**
   * Helper: Create Co-Pilot (pending) evaluation
   */
  async function createCopilotEvaluation(
    companyId: string,
    taskIssueId: string,
    aiScore: number,
    evaluator: string,
    rationale: string | undefined,
    reason: string,
    policyDecision: Rt2JarvisAutoPolicyDecision,
  ): Promise<AutoEvaluationResult> {
    const [evaluation] = await db
      .insert(rt2QualityScores)
      .values({
        companyId,
        taskIssueId,
        evaluator,
        evalType: "ai_auto_copilot",
        score: aiScore,
        direction: aiScore >= 50 ? "positive" : "negative",
        category: "auto_evaluated",
        rationale: rationale || reason,
        isActive: 0,
        managerDecision: "pending",
        isFinalized: 0,
        basePrice: policyDecision.basePrice,
        autoApprovalBandLow: policyDecision.bandLow,
        autoApprovalBandHigh: policyDecision.bandHigh,
        evaluationMode: "copilot",
      })
      .returning();

    const expectedScore = 0; // Unknown without base price

    return {
      evaluation: evaluation as AutoEvaluation,
      expectedScore,
      isWithinBand: false,
      autoApproved: false,
      policyDecision,
    };
  }

  async function getManagerReviewQueue(companyId: string): Promise<Rt2JarvisQualityReviewQueue> {
    const rows = await db
      .select({
        id: rt2QualityScores.id,
        companyId: rt2QualityScores.companyId,
        deliverableId: rt2QualityScores.deliverableId,
        taskIssueId: rt2QualityScores.taskIssueId,
        evaluator: rt2QualityScores.evaluator,
        evalType: rt2QualityScores.evalType,
        score: rt2QualityScores.score,
        direction: rt2QualityScores.direction,
        category: rt2QualityScores.category,
        rationale: rt2QualityScores.rationale,
        isActive: rt2QualityScores.isActive,
        managerDecision: rt2QualityScores.managerDecision,
        managerId: rt2QualityScores.managerId,
        managerFeedback: rt2QualityScores.managerFeedback,
        isFinalized: rt2QualityScores.isFinalized,
        basePrice: rt2QualityScores.basePrice,
        autoApprovalBandLow: rt2QualityScores.autoApprovalBandLow,
        autoApprovalBandHigh: rt2QualityScores.autoApprovalBandHigh,
        evaluationMode: rt2QualityScores.evaluationMode,
        createdAt: rt2QualityScores.createdAt,
        updatedAt: rt2QualityScores.updatedAt,
        taskTitle: issues.title,
        taskStatus: issues.status,
        deliverableTitle: issueWorkProducts.title,
        deliverableType: issueWorkProducts.type,
        deliverableStatus: issueWorkProducts.status,
        deliverableReviewState: issueWorkProducts.reviewState,
      })
      .from(rt2QualityScores)
      .innerJoin(issues, eq(rt2QualityScores.taskIssueId, issues.id))
      .leftJoin(issueWorkProducts, eq(rt2QualityScores.deliverableId, issueWorkProducts.id))
      .where(and(eq(rt2QualityScores.companyId, companyId), sql`${rt2QualityScores.evaluationMode} IS NOT NULL`))
      .orderBy(desc(rt2QualityScores.createdAt))
      .limit(100);

    const items = rows.map((row) => {
      const mode = (row.evaluationMode ?? "copilot") as "shadow" | "copilot" | "auto";
      const expectedDeltaGold = row.basePrice == null ? null : Math.round(row.basePrice * (row.score / 100));
      const policyDecision: Rt2JarvisPolicyDecision = mode === "shadow"
        ? "record_only"
        : row.managerDecision === "approved" && row.isFinalized === 1 && mode === "auto"
          ? "auto_approved"
          : "requires_copilot";
      const policyReason = policyDecision === "record_only"
        ? "Shadow mode evidence only."
        : policyDecision === "auto_approved"
          ? "Auto policy band approved this evaluation."
          : "Manager review is required before activation.";

      return {
        evaluationId: row.id,
        companyId: row.companyId,
        taskIssueId: row.taskIssueId,
        taskTitle: row.taskTitle,
        deliverableId: row.deliverableId,
        deliverableTitle: row.deliverableTitle ?? null,
        deliverableType: row.deliverableType ?? row.evalType,
        evaluator: row.evaluator,
        evaluationMode: mode,
        score: row.score,
        direction: row.direction as "positive" | "negative",
        category: row.category,
        rationale: row.rationale,
        managerDecision: row.managerDecision as "approved" | "rejected" | "pending" | null,
        managerFeedback: row.managerFeedback,
        isActive: row.isActive,
        isFinalized: row.isFinalized,
        basePrice: row.basePrice,
        expectedDeltaGold,
        autoApprovalBandLow: row.autoApprovalBandLow,
        autoApprovalBandHigh: row.autoApprovalBandHigh,
        policyDecision,
        policyReason,
        evidence: {
          taskStatus: row.taskStatus,
          deliverableStatus: row.deliverableStatus ?? null,
          deliverableReviewState: row.deliverableReviewState ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
      };
    });

    return {
      companyId,
      items,
      stats: {
        shadow: items.filter((item) => item.evaluationMode === "shadow").length,
        copilotPending: items.filter((item) => item.evaluationMode === "copilot" && item.managerDecision === "pending").length,
        autoApproved: items.filter((item) => item.evaluationMode === "auto" && item.managerDecision === "approved").length,
        rejected: items.filter((item) => item.managerDecision === "rejected").length,
      },
    };
  }

  async function decideEvaluation(
    companyId: string,
    evaluationId: string,
    decision: "approved" | "rejected",
    managerId: string,
    feedback?: string,
  ): Promise<AutoEvaluation> {
    const [updated] = await db
      .update(rt2QualityScores)
      .set({
        managerDecision: decision,
        managerId,
        managerFeedback: feedback ?? null,
        isActive: decision === "approved" ? 1 : 0,
        isFinalized: 1,
        updatedAt: new Date(),
      })
      .where(and(eq(rt2QualityScores.id, evaluationId), eq(rt2QualityScores.companyId, companyId)))
      .returning();

    if (!updated) throw notFound("RT2 quality evaluation not found");
    return updated as AutoEvaluation;
  }

  /**
   * M4.1: List evaluations with optional mode filter
   */
  async function getEvaluations(
    companyId: string,
    options: {
      mode?: "shadow" | "auto" | "copilot";
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<AutoEvaluation[]> {
    const conditions = [eq(rt2QualityScores.companyId, companyId)];

    if (options.mode) {
      conditions.push(eq(rt2QualityScores.evaluationMode, options.mode) as any);
    }

    const rows = await db
      .select()
      .from(rt2QualityScores)
      .where(and(...conditions))
      .orderBy(desc(rt2QualityScores.createdAt))
      .limit(options.limit ?? 50)
      .offset(options.offset ?? 0);

    return rows.map((r) => ({
      ...r,
      managerDecision: r.managerDecision as AutoEvaluation["managerDecision"],
      evaluationMode: r.evaluationMode as AutoEvaluation["evaluationMode"],
    })) as AutoEvaluation[];
  }

  /**
   * M4.1: Get auto evaluation statistics
   */
  async function getStats(companyId: string): Promise<AutoEvaluationStats> {
    const rows = await db
      .select()
      .from(rt2QualityScores)
      .where(
        and(
          eq(rt2QualityScores.companyId, companyId),
          sql`${rt2QualityScores.evaluationMode} IS NOT NULL`,
        ),
      );

    const autoApproved = rows.filter(
      (r) => r.evaluationMode === "auto" && r.isFinalized === 1,
    ).length;
    const copilotPending = rows.filter(
      (r) => r.evaluationMode === "copilot" && r.isFinalized === 0,
    ).length;
    const totalEvaluations = rows.length;
    const averageScore =
      totalEvaluations > 0
        ? Math.round(rows.reduce((sum, r) => sum + r.score, 0) / totalEvaluations)
        : 0;

    // Group by category (using evalType as proxy for deliverable type)
    const byDeliverableType: AutoEvaluationStats["byDeliverableType"] = {};
    for (const row of rows) {
      const key = row.evalType;
      if (!byDeliverableType[key]) {
        byDeliverableType[key] = { count: 0, autoApproved: 0, copilotPending: 0 };
      }
      byDeliverableType[key].count++;
      if (row.evaluationMode === "auto") {
        byDeliverableType[key].autoApproved++;
      } else if (row.evaluationMode === "copilot") {
        byDeliverableType[key].copilotPending++;
      }
    }

    return {
      totalEvaluations,
      autoApproved,
      copilotPending,
      autoApprovalRate: totalEvaluations > 0 ? Math.round((autoApproved / totalEvaluations) * 100) : 0,
      averageScore,
      byDeliverableType,
    };
  }

  return {
    getBasePrice,
    setBasePrice,
    deleteBasePrice,
    listBasePrices,
    updateThreshold,
    decideAutoPolicy,
    evaluateDeliverable,
    getManagerReviewQueue,
    decideEvaluation,
    getEvaluations,
    getStats,
  };
}

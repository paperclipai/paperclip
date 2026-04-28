import { and, desc, eq, sql, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  rt2PromotionTriggers,
  rt2PerformanceReviews,
  rt2CreditConversionLedger,
  rt2CollaborationRewards,
  rt2CollaborationEvents,
  rt2GamificationAgentBalances,
  CREDITS_PER_GOLD,
  PROMOTION_TIERS,
  calculateGrade,
  getTierFromReputation,
  calculateGoldFromCredits,
} from "@paperclipai/db";
import { notFound } from "../errors.js";

// ============================================================================
// Types
// ============================================================================

export type PromotionTrigger = {
  id: string;
  companyId: string;
  agentId: string;
  reputationThreshold: number;
  tierReached: string;
  status: "pending" | "approved" | "rejected" | "auto_promoted";
  triggeredAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PerformanceReview = {
  id: string;
  companyId: string;
  agentId: string;
  reviewPeriod: "quarterly" | "halfyearly" | "yearly";
  periodStart: Date | string;
  periodEnd: Date | string;
  reputationStart: number;
  reputationEnd: number;
  reputationDelta: number;
  grade: "S" | "A" | "B" | "C" | "D";
  feedback: string | null;
  reviewerId: string | null;
  status: "draft" | "submitted" | "acknowledged";
  createdAt: Date;
  updatedAt: Date;
};

export type CreditConversion = {
  id: string;
  companyId: string;
  actorId: string;
  actorType: "user" | "agent";
  creditsConverted: number;
  goldReceived: number;
  conversionRate: number;
  source: string;
  referenceId: string | null;
  createdAt: Date;
};

export type CreditBalance = {
  actorId: string;
  actorType: "user" | "agent";
  totalCredits: number;
  availableCredits: number;
  lifetimeConverted: number;
};

// ============================================================================
// Service
// ============================================================================

export function rt2ReputationExpansionService(db: Db) {
  /**
   * M4.2: Get or create collaboration reward record for an actor
   */
  async function getOrCreateCollaborationReward(
    companyId: string,
    actorId: string,
    actorType: "user" | "agent",
  ) {
    const existing = await db
      .select()
      .from(rt2CollaborationRewards)
      .where(
        and(
          eq(rt2CollaborationRewards.companyId, companyId),
          eq(rt2CollaborationRewards.actorId, actorId),
          eq(rt2CollaborationRewards.actorType, actorType),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) return existing;

    const [created] = await db
      .insert(rt2CollaborationRewards)
      .values({
        companyId,
        actorId,
        actorType,
        reputationIndex: 500,
        multiplier: 1.0,
        aiContributionScore: 0,
        totalCollaborations: 0,
        successfulCollaborations: 0,
      })
      .returning();

    return created;
  }

  /**
   * M4.2: Check if an agent qualifies for promotion
   */
  async function checkPromotionEligibility(
    companyId: string,
    agentId: string,
  ): Promise<{
    eligible: boolean;
    currentReputation: number;
    tierReached: string | null;
    pendingTrigger: PromotionTrigger | null;
  }> {
    const reward = await getOrCreateCollaborationReward(companyId, agentId, "agent");

    const currentReputation = reward.reputationIndex;
    const tierReached = getTierFromReputation(currentReputation);

    // Check if there's already a pending trigger
    const existingTrigger = await db
      .select()
      .from(rt2PromotionTriggers)
      .where(
        and(
          eq(rt2PromotionTriggers.companyId, companyId),
          eq(rt2PromotionTriggers.agentId, agentId),
          eq(rt2PromotionTriggers.status, "pending"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    // Determine eligible tiers
    const eligibleTiers = ["senior", "expert", "legend"];
    const isEligible = eligibleTiers.includes(tierReached);

    return {
      eligible: isEligible,
      currentReputation,
      tierReached: isEligible ? tierReached : null,
      pendingTrigger: existingTrigger as PromotionTrigger | null,
    };
  }

  /**
   * M4.2: Create a promotion trigger when threshold is crossed
   */
  async function createPromotionTrigger(
    companyId: string,
    agentId: string,
    tierReached: string,
    reputationThreshold: number,
  ): Promise<PromotionTrigger> {
    // Check if pending trigger already exists
    const existing = await db
      .select()
      .from(rt2PromotionTriggers)
      .where(
        and(
          eq(rt2PromotionTriggers.companyId, companyId),
          eq(rt2PromotionTriggers.agentId, agentId),
          eq(rt2PromotionTriggers.status, "pending"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      return existing as PromotionTrigger;
    }

    const [trigger] = await db
      .insert(rt2PromotionTriggers)
      .values({
        companyId,
        agentId,
        reputationThreshold,
        tierReached,
        status: "pending",
      })
      .returning();

    return trigger as PromotionTrigger;
  }

  /**
   * M4.2: Resolve a promotion trigger (approve/reject/auto)
   */
  async function resolvePromotion(
    triggerId: string,
    companyId: string,
    decision: "approved" | "rejected" | "auto_promoted",
    resolvedBy: string,
  ): Promise<PromotionTrigger> {
    const [updated] = await db
      .update(rt2PromotionTriggers)
      .set({
        status: decision,
        resolvedAt: new Date(),
        resolvedBy,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(rt2PromotionTriggers.id, triggerId),
          eq(rt2PromotionTriggers.companyId, companyId),
        ),
      )
      .returning();

    if (!updated) {
      throw notFound(`Promotion trigger ${triggerId} not found`);
    }

    // If auto_promoted, update the multiplier
    if (decision === "auto_promoted") {
      const trigger = updated;
      const tierMultiplier = trigger.tierReached === "legend" ? 1.5 :
                            trigger.tierReached === "expert" ? 1.3 : 1.1;

      await db
        .update(rt2CollaborationRewards)
        .set({
          multiplier: tierMultiplier,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(rt2CollaborationRewards.companyId, companyId),
            eq(rt2CollaborationRewards.actorId, trigger.agentId),
            eq(rt2CollaborationRewards.actorType, "agent" as any),
          ),
        );
    }

    return updated as PromotionTrigger;
  }

  /**
   * M4.2: Get pending promotions for a company
   */
  async function getPendingPromotions(companyId: string): Promise<PromotionTrigger[]> {
    return db
      .select()
      .from(rt2PromotionTriggers)
      .where(
        and(
          eq(rt2PromotionTriggers.companyId, companyId),
          eq(rt2PromotionTriggers.status, "pending"),
        ),
      )
      .orderBy(desc(rt2PromotionTriggers.triggeredAt)) as Promise<PromotionTrigger[]>;
  }

  /**
   * M4.2: Create a performance review draft
   */
  async function createPerformanceReview(
    companyId: string,
    agentId: string,
    reviewPeriod: "quarterly" | "halfyearly" | "yearly",
    periodStart: Date,
    periodEnd: Date,
  ): Promise<PerformanceReview> {
    // Get reputation at start and end
    const reward = await getOrCreateCollaborationReward(companyId, agentId, "agent");

    // For periodEnd reputation, use current. For periodStart, we'd need historical data
    // For now, use the current reputation as both (simplified)
    const reputationEnd = reward.reputationIndex;
    const reputationStart = Math.max(300, reputationEnd - 50); // Placeholder delta
    const reputationDelta = reputationEnd - reputationStart;
    const grade = calculateGrade(reputationDelta);

    const [review] = await db
      .insert(rt2PerformanceReviews)
      .values({
        companyId: companyId,
        agentId: agentId,
        reviewPeriod: reviewPeriod,
        periodStart: typeof periodStart === 'string' ? periodStart : periodStart.toISOString().split('T')[0],
        periodEnd: typeof periodEnd === 'string' ? periodEnd : periodEnd.toISOString().split('T')[0],
        reputationStart: reputationStart,
        reputationEnd: reputationEnd,
        reputationDelta: reputationDelta,
        grade: grade,
        status: "draft",
      })
      .returning();

    return review as PerformanceReview;
  }

  /**
   * M4.2: Get performance review by ID
   */
  async function getPerformanceReview(
    reviewId: string,
    companyId: string,
  ): Promise<PerformanceReview | null> {
    return db
      .select()
      .from(rt2PerformanceReviews)
      .where(
        and(
          eq(rt2PerformanceReviews.id, reviewId),
          eq(rt2PerformanceReviews.companyId, companyId),
        ),
      )
      .then((rows) => (rows[0] ?? null) as PerformanceReview | null);
  }

  /**
   * M4.2: Update/submit performance review
   */
  async function submitPerformanceReview(
    reviewId: string,
    companyId: string,
    data: {
      feedback?: string;
      grade?: "S" | "A" | "B" | "C" | "D";
      status?: "draft" | "submitted" | "acknowledged";
    },
  ): Promise<PerformanceReview> {
    const [updated] = await db
      .update(rt2PerformanceReviews)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(rt2PerformanceReviews.id, reviewId),
          eq(rt2PerformanceReviews.companyId, companyId),
        ),
      )
      .returning();

    if (!updated) {
      throw notFound(`Performance review ${reviewId} not found`);
    }

    return updated as PerformanceReview;
  }

  /**
   * M4.2: Get performance reviews for a company
   */
  async function getPerformanceReviews(
    companyId: string,
    options: {
      agentId?: string;
      reviewPeriod?: string;
      status?: string;
      limit?: number;
    } = {},
  ): Promise<PerformanceReview[]> {
    const conditions = [eq(rt2PerformanceReviews.companyId, companyId)];

    if (options.agentId) {
      conditions.push(eq(rt2PerformanceReviews.agentId, options.agentId) as any);
    }
    if (options.reviewPeriod) {
      conditions.push(eq(rt2PerformanceReviews.reviewPeriod, options.reviewPeriod) as any);
    }
    if (options.status) {
      conditions.push(eq(rt2PerformanceReviews.status, options.status) as any);
    }

    return db
      .select()
      .from(rt2PerformanceReviews)
      .where(and(...conditions))
      .orderBy(desc(rt2PerformanceReviews.periodEnd))
      .limit(options.limit ?? 50) as Promise<PerformanceReview[]>;
  }

  /**
   * M4.2: Get credit balance for an actor
   */
  async function getCreditBalance(
    companyId: string,
    actorId: string,
    actorType: "user" | "agent",
  ): Promise<CreditBalance> {
    // Sum up all credits from collaboration events
    const creditsResult = await db
      .select({
        total: sql<number>`COALESCE(SUM(${rt2CollaborationEvents.pointsEarned}), 0)`,
      })
      .from(rt2CollaborationEvents)
      .where(
        and(
          eq(rt2CollaborationEvents.companyId, companyId),
          eq(rt2CollaborationEvents.actorId, actorId),
          eq(rt2CollaborationEvents.actorType, actorType),
          eq(rt2CollaborationEvents.successful, "yes"),
        ),
      );

    const totalCredits = Number(creditsResult[0]?.total ?? 0);

    // Sum up converted credits
    const convertedResult = await db
      .select({
        total: sql<number>`COALESCE(SUM(${rt2CreditConversionLedger.creditsConverted}), 0)`,
      })
      .from(rt2CreditConversionLedger)
      .where(
        and(
          eq(rt2CreditConversionLedger.companyId, companyId),
          eq(rt2CreditConversionLedger.actorId, actorId),
          eq(rt2CreditConversionLedger.actorType, actorType),
        ),
      );

    const lifetimeConverted = Number(convertedResult[0]?.total ?? 0);

    return {
      actorId,
      actorType,
      totalCredits,
      availableCredits: totalCredits - lifetimeConverted,
      lifetimeConverted,
    };
  }

  /**
   * M4.2: Convert credits to gold
   */
  async function convertCreditsToGold(
    companyId: string,
    actorId: string,
    actorType: "user" | "agent",
    creditsToConvert?: number, // If undefined, convert all available
  ): Promise<{
    creditsConverted: number;
    goldReceived: number;
    remainingCredits: number;
    newBalance: number;
  }> {
    const balance = await getCreditBalance(companyId, actorId, actorType);
    const creditsToUse = creditsToConvert ?? balance.availableCredits;

    if (creditsToUse > balance.availableCredits) {
      throw new Error(`Insufficient credits. Available: ${balance.availableCredits}, requested: ${creditsToUse}`);
    }

    const { gold, remainingCredits } = calculateGoldFromCredits(creditsToUse);

    if (gold <= 0) {
      throw new Error("Insufficient credits for conversion (need at least 10 credits)");
    }

    // Record the conversion
    await db
      .insert(rt2CreditConversionLedger)
      .values({
        companyId,
        actorId,
        actorType,
        creditsConverted: creditsToUse,
        goldReceived: gold,
        conversionRate: 1 / CREDITS_PER_GOLD,
        source: "manual",
      });

    // Update agent gold balance
    const existingBalance = await db
      .select()
      .from(rt2GamificationAgentBalances)
      .where(
        and(
          eq(rt2GamificationAgentBalances.companyId, companyId),
          eq(rt2GamificationAgentBalances.agentId, actorId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existingBalance) {
      await db
        .update(rt2GamificationAgentBalances)
        .set({
          balance: existingBalance.balance + gold,
          lifetimeEarned: existingBalance.lifetimeEarned + gold,
          updatedAt: new Date(),
        })
        .where(eq(rt2GamificationAgentBalances.id, existingBalance.id));
    } else {
      await db
        .insert(rt2GamificationAgentBalances)
        .values({
          companyId,
          agentId: actorId,
          balance: gold,
          lifetimeEarned: gold,
        });
    }

    const newBalance = balance.availableCredits - creditsToUse;

    return {
      creditsConverted: creditsToUse,
      goldReceived: gold,
      remainingCredits,
      newBalance,
    };
  }

  /**
   * M4.2: Get conversion history
   */
  async function getConversionHistory(
    companyId: string,
    actorId?: string,
    limit: number = 50,
  ): Promise<CreditConversion[]> {
    const conditions = [eq(rt2CreditConversionLedger.companyId, companyId)];

    if (actorId) {
      conditions.push(eq(rt2CreditConversionLedger.actorId, actorId) as any);
    }

    return db
      .select()
      .from(rt2CreditConversionLedger)
      .where(and(...conditions))
      .orderBy(desc(rt2CreditConversionLedger.createdAt))
      .limit(limit) as Promise<CreditConversion[]>;
  }

  return {
    checkPromotionEligibility,
    createPromotionTrigger,
    resolvePromotion,
    getPendingPromotions,
    createPerformanceReview,
    getPerformanceReview,
    submitPerformanceReview,
    getPerformanceReviews,
    getCreditBalance,
    convertCreditsToGold,
    getConversionHistory,
  };
}

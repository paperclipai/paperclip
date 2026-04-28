import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  rt2GamificationXpTransactions,
  rt2GamificationLevelHistory,
  rt2GamificationAchievements,
  rt2GamificationAgentBalances,
  agents,
  issues,
  financeEvents,
} from "@paperclipai/db";
import type {
  Rt2XpTransaction,
  Rt2LevelHistoryEntry,
  Rt2Achievement,
  Rt2AgentBalance,
  Rt2Leaderboard,
  Rt2LeaderboardEntry,
  Rt2AgentScore,
  Rt2AchievementsSummary,
  Rt2XpActivityType,
  Rt2LevelTrigger,
  Rt2TokenBalance,
  Rt2TransactionHistory,
  Rt2CostBreakdown,
} from "@paperclipai/shared";
import { RT2_XP_REWARDS, calculateLevel } from "@paperclipai/shared";
import { notFound } from "../errors.js";

/**
 * Full Gamification Service
 *
 * Provides:
 * - getLeaderboard: Company/project leaderboard ranked by XP/level
 * - getAgentScore: Detailed score breakdown for an agent
 * - getAchievements: Achievement status for an agent
 * - awardXp: Award XP to an agent (creates transaction, may trigger level-up)
 * - getXpHistory: XP transaction history for an agent
 * - getLevelHistory: Level changes for an agent
 * - getAgentBalance: Gold balance for an agent
 * - awardGold: Award gold to an agent
 */
export function rt2GamificationService(db: Db) {
  // -------------------------------------------------------------------------
  // Leaderboard
  // -------------------------------------------------------------------------

  /**
   * Get leaderboard entries for a company (optionally filtered by project)
   */
  const getLeaderboard = async (
    companyId: string,
    projectId?: string,
  ): Promise<Rt2Leaderboard> => {
    // Get all XP transactions grouped by agent
    const agentXpRows = await db
      .select({
        agentId: rt2GamificationXpTransactions.agentId,
        totalXp: sql<number>`COALESCE(SUM(${rt2GamificationXpTransactions.xpAmount}), 0)`,
      })
      .from(rt2GamificationXpTransactions)
      .where(eq(rt2GamificationXpTransactions.companyId, companyId))
      .groupBy(rt2GamificationXpTransactions.agentId);

    // Get agent info
    const agentIds = agentXpRows.map((r) => r.agentId).filter(Boolean) as string[];
    let agentInfos: { id: string; name: string }[] = [];

    if (agentIds.length > 0) {
      const rows = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(sql`${agents.id} IN (${sql.join(agentIds.map(id => sql`${id}`), sql`, `)})`);

      agentInfos = rows.map((r) => ({ id: r.id, name: r.name ?? "Unknown" }));
    }

    const agentMap = new Map(agentInfos.map((a) => [a.id, a.name]));

    // Get task completion counts
    const taskCountsRows = await db
      .select({
        agentId: rt2GamificationXpTransactions.agentId,
        count: sql<number>`COUNT(*)`,
      })
      .from(rt2GamificationXpTransactions)
      .where(
        and(
          eq(rt2GamificationXpTransactions.companyId, companyId),
          eq(rt2GamificationXpTransactions.activityType, "task_complete"),
        ),
      )
      .groupBy(rt2GamificationXpTransactions.agentId);

    const taskCountMap = new Map(taskCountsRows.map((r) => [r.agentId as string, Number(r.count)]));

    // Get achievement counts
    const achievementCountsRows = await db
      .select({
        agentId: rt2GamificationAchievements.agentId,
        count: sql<number>`COUNT(*)`,
      })
      .from(rt2GamificationAchievements)
      .where(
        and(
          eq(rt2GamificationAchievements.companyId, companyId),
          sql`${rt2GamificationAchievements.earnedAt} IS NOT NULL`,
        ),
      )
      .groupBy(rt2GamificationAchievements.agentId);

    const achievementCountMap = new Map(
      achievementCountsRows.map((r) => [r.agentId as string, Number(r.count)]),
    );

    // Get gold balances
    const balanceRows = await db
      .select({
        agentId: rt2GamificationAgentBalances.agentId,
        balance: rt2GamificationAgentBalances.balance,
      })
      .from(rt2GamificationAgentBalances)
      .where(eq(rt2GamificationAgentBalances.companyId, companyId));

    const balanceMap = new Map(balanceRows.map((r) => [r.agentId, Number(r.balance)]));

    // Build entries sorted by total XP
    const entries: Rt2LeaderboardEntry[] = agentXpRows
      .map((row) => {
        const agentId = row.agentId ?? "unknown";
        const totalXp = Number(row.totalXp);
        const level = calculateLevel(totalXp);
        return {
          rank: 0, // Will be set after sorting
          agentId,
          agentName: agentMap.get(agentId) ?? "Unknown",
          level,
          totalXp,
          tasksCompleted: taskCountMap.get(agentId) ?? 0,
          achievementsCount: achievementCountMap.get(agentId) ?? 0,
          goldBalance: balanceMap.get(agentId) ?? 0,
        };
      })
      .filter((e) => e.totalXp > 0)
      .sort((a, b) => b.totalXp - a.totalXp)
      .map((entry, idx) => ({ ...entry, rank: idx + 1 }));

    return {
      companyId,
      projectId: projectId ?? null,
      entries,
      updatedAt: new Date().toISOString(),
    };
  };

  // -------------------------------------------------------------------------
  // Agent Score
  // -------------------------------------------------------------------------

  /**
   * Get detailed score breakdown for an agent
   */
  const getAgentScore = async (
    companyId: string,
    agentId: string,
  ): Promise<Rt2AgentScore> => {
    // Get total XP
    const xpRows = await db
      .select({ total: sql<number>`COALESCE(SUM(${rt2GamificationXpTransactions.xpAmount}), 0)` })
      .from(rt2GamificationXpTransactions)
      .where(
        and(
          eq(rt2GamificationXpTransactions.companyId, companyId),
          eq(rt2GamificationXpTransactions.agentId, agentId),
        ),
      );

    const totalXp = Number(xpRows[0]?.total ?? 0);

    // Get task completion count
    const taskRows = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(rt2GamificationXpTransactions)
      .where(
        and(
          eq(rt2GamificationXpTransactions.companyId, companyId),
          eq(rt2GamificationXpTransactions.agentId, agentId),
          eq(rt2GamificationXpTransactions.activityType, "task_complete"),
        ),
      );

    const tasksCompleted = Number(taskRows[0]?.count ?? 0);

    // Get approval count (quality proxy)
    const approvalRows = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(rt2GamificationXpTransactions)
      .where(
        and(
          eq(rt2GamificationXpTransactions.companyId, companyId),
          eq(rt2GamificationXpTransactions.agentId, agentId),
          eq(rt2GamificationXpTransactions.activityType, "approval"),
        ),
      );

    const approvalsCount = Number(approvalRows[0]?.count ?? 0);

    // Calculate scores
    const qualityScore = Math.min(100, tasksCompleted * 5 + approvalsCount * 10);
    const collaborationScore = Math.min(100, tasksCompleted * 3);
    const overallScore = totalXp;

    return {
      companyId,
      agentId,
      tasksCompleted,
      qualityScore,
      collaborationScore,
      overallScore,
    };
  };

  // -------------------------------------------------------------------------
  // Achievements
  // -------------------------------------------------------------------------

  /**
   * Get achievement summary for an agent
   */
  const getAchievements = async (
    companyId: string,
    agentId: string,
  ): Promise<Rt2AchievementsSummary> => {
    const rows = await db
      .select()
      .from(rt2GamificationAchievements)
      .where(
        and(
          eq(rt2GamificationAchievements.companyId, companyId),
          eq(rt2GamificationAchievements.agentId, agentId),
        ),
      );

    const achievements: Rt2Achievement[] = rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      agentId: row.agentId,
      achievementKey: row.achievementKey,
      scope: row.scope as import("@paperclipai/shared").Rt2AchievementScope,
      earnedAt: row.earnedAt,
      metadataJson: row.metadataJson,
      createdAt: row.createdAt,
    }));

    const unlockedCount = achievements.filter((a) => a.earnedAt !== null).length;
    const totalCount = 13; // Number of predefined achievements

    return {
      companyId,
      agentId,
      achievements,
      unlockedCount,
      totalCount,
    };
  };

  /**
   * Check and award achievements based on triggers
   */
  const checkAchievements = async (
    companyId: string,
    agentId: string,
    trigger: Rt2XpActivityType,
  ): Promise<Rt2Achievement[]> => {
    const newlyEarned: Rt2Achievement[] = [];

    // Get current achievement state
    const existingRows = await db
      .select()
      .from(rt2GamificationAchievements)
      .where(
        and(
          eq(rt2GamificationAchievements.companyId, companyId),
          eq(rt2GamificationAchievements.agentId, agentId),
        ),
      );

    const earnedKeys = new Set(
      existingRows.filter((r) => r.earnedAt !== null).map((r) => r.achievementKey),
    );

    // Get stats for achievement checks
    const taskCount = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(rt2GamificationXpTransactions)
      .where(
        and(
          eq(rt2GamificationXpTransactions.companyId, companyId),
          eq(rt2GamificationXpTransactions.agentId, agentId),
          eq(rt2GamificationXpTransactions.activityType, "task_complete"),
        ),
      )
      .then((r) => Number(r[0]?.count ?? 0));

    const xpRows = await db
      .select({ total: sql<number>`COALESCE(SUM(${rt2GamificationXpTransactions.xpAmount}), 0)` })
      .from(rt2GamificationXpTransactions)
      .where(
        and(
          eq(rt2GamificationXpTransactions.companyId, companyId),
          eq(rt2GamificationXpTransactions.agentId, agentId),
        ),
      );

    const totalXp = Number(xpRows[0]?.total ?? 0);
    const level = calculateLevel(totalXp);

    // Define achievement checks
    const checks: Array<{ key: string; condition: boolean; metadata?: Record<string, unknown> }> = [
      { key: "first_task", condition: taskCount >= 1 },
      { key: "ten_tasks", condition: taskCount >= 10 },
      { key: "fifty_tasks", condition: taskCount >= 50 },
      { key: "hundred_tasks", condition: taskCount >= 100 },
      { key: "level_5", condition: level >= 5 },
      { key: "level_10", condition: level >= 10 },
      { key: "level_25", condition: level >= 25 },
    ];

    for (const check of checks) {
      if (check.condition && !earnedKeys.has(check.key)) {
        const now = new Date();
        const insertResult = await db
          .insert(rt2GamificationAchievements)
          .values({
            companyId,
            agentId,
            achievementKey: check.key,
            scope: "agent",
            earnedAt: now,
            metadataJson: check.metadata ? JSON.stringify(check.metadata) : null,
            createdAt: now,
          })
          .returning();

        newlyEarned.push({
          id: insertResult[0].id,
          companyId: insertResult[0].companyId,
          agentId: insertResult[0].agentId,
          achievementKey: insertResult[0].achievementKey,
          scope: insertResult[0].scope as import("@paperclipai/shared").Rt2AchievementScope,
          earnedAt: insertResult[0].earnedAt,
          metadataJson: insertResult[0].metadataJson,
          createdAt: insertResult[0].createdAt,
        });
      }
    }

    return newlyEarned;
  };

  // -------------------------------------------------------------------------
  // XP & Level Management
  // -------------------------------------------------------------------------

  /**
   * Award XP to an agent and handle level-ups
   */
  const awardXp = async (
    companyId: string,
    agentId: string,
    activityType: Rt2XpActivityType,
    issueId?: string,
    description?: string,
  ): Promise<{ transaction: Rt2XpTransaction; newAchievements: Rt2Achievement[]; leveledUp: boolean; newLevel: number }> => {
    const xpAmount = RT2_XP_REWARDS[activityType] ?? 10;

    // Get current balance
    const currentBalance = await db
      .select({ balance: sql<number>`COALESCE(SUM(${rt2GamificationXpTransactions.xpAmount}), 0)` })
      .from(rt2GamificationXpTransactions)
      .where(
        and(
          eq(rt2GamificationXpTransactions.companyId, companyId),
          eq(rt2GamificationXpTransactions.agentId, agentId),
        ),
      )
      .then((r) => Number(r[0]?.balance ?? 0));

    const oldLevel = calculateLevel(currentBalance);
    const newBalance = currentBalance + xpAmount;
    const newLevel = calculateLevel(newBalance);
    const leveledUp = newLevel > oldLevel;

    const now = new Date();

    // Create XP transaction
    const txResult = await db
      .insert(rt2GamificationXpTransactions)
      .values({
        companyId,
        agentId,
        issueId: issueId ?? null,
        activityType,
        xpAmount,
        balanceAfter: newBalance,
        description: description ?? `${activityType}: +${xpAmount} XP`,
        createdAt: now,
      })
      .returning();

    const transaction: Rt2XpTransaction = {
      id: txResult[0].id,
      companyId: txResult[0].companyId,
      agentId: txResult[0].agentId,
      issueId: txResult[0].issueId,
      activityType: txResult[0].activityType as Rt2XpActivityType,
      xpAmount: txResult[0].xpAmount,
      balanceAfter: txResult[0].balanceAfter,
      description: txResult[0].description,
      createdAt: txResult[0].createdAt,
    };

    // Record level change if leveled up
    if (leveledUp) {
      await db
        .insert(rt2GamificationLevelHistory)
        .values({
          companyId,
          agentId,
          levelBefore: oldLevel,
          levelAfter: newLevel,
          xpAtChange: newBalance,
          trigger: mapActivityToTrigger(activityType),
          description: `Level up from ${oldLevel} to ${newLevel}`,
          createdAt: now,
        });
    }

    // Check achievements
    const newAchievements = await checkAchievements(companyId, agentId, activityType);

    return { transaction, newAchievements, leveledUp, newLevel };
  };

  /**
   * Get XP transaction history for an agent
   */
  const getXpHistory = async (
    companyId: string,
    agentId: string,
    limit = 50,
  ): Promise<Rt2XpTransaction[]> => {
    const rows = await db
      .select()
      .from(rt2GamificationXpTransactions)
      .where(
        and(
          eq(rt2GamificationXpTransactions.companyId, companyId),
          eq(rt2GamificationXpTransactions.agentId, agentId),
        ),
      )
      .orderBy(desc(rt2GamificationXpTransactions.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      agentId: row.agentId,
      issueId: row.issueId,
      activityType: row.activityType as Rt2XpActivityType,
      xpAmount: row.xpAmount,
      balanceAfter: row.balanceAfter,
      description: row.description,
      createdAt: row.createdAt,
    }));
  };

  /**
   * Get level history for an agent
   */
  const getLevelHistory = async (
    companyId: string,
    agentId: string,
  ): Promise<Rt2LevelHistoryEntry[]> => {
    const rows = await db
      .select()
      .from(rt2GamificationLevelHistory)
      .where(
        and(
          eq(rt2GamificationLevelHistory.companyId, companyId),
          eq(rt2GamificationLevelHistory.agentId, agentId),
        ),
      )
      .orderBy(desc(rt2GamificationLevelHistory.createdAt));

    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      agentId: row.agentId,
      levelBefore: row.levelBefore,
      levelAfter: row.levelAfter,
      xpAtChange: row.xpAtChange,
      trigger: row.trigger as Rt2LevelTrigger,
      description: row.description,
      createdAt: row.createdAt,
    }));
  };

  // -------------------------------------------------------------------------
  // Gold / Economy
  // -------------------------------------------------------------------------

  /**
   * Get or create agent gold balance
   */
  const getAgentBalance = async (
    companyId: string,
    agentId: string,
  ): Promise<Rt2AgentBalance> => {
    const rows = await db
      .select()
      .from(rt2GamificationAgentBalances)
      .where(
        and(
          eq(rt2GamificationAgentBalances.companyId, companyId),
          eq(rt2GamificationAgentBalances.agentId, agentId),
        ),
      );

    if (rows.length > 0) {
      const row = rows[0];
      return {
        id: row.id,
        companyId: row.companyId,
        agentId: row.agentId,
        balance: row.balance,
        lifetimeEarned: row.lifetimeEarned,
        lifetimeSpent: row.lifetimeSpent,
        updatedAt: row.updatedAt,
        createdAt: row.createdAt,
      };
    }

    // Create new balance
    const now = new Date();
    const insertResult = await db
      .insert(rt2GamificationAgentBalances)
      .values({
        companyId,
        agentId,
        balance: 0,
        lifetimeEarned: 0,
        lifetimeSpent: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const row = insertResult[0];
    return {
      id: row.id,
      companyId: row.companyId,
      agentId: row.agentId,
      balance: row.balance,
      lifetimeEarned: row.lifetimeEarned,
      lifetimeSpent: row.lifetimeSpent,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
    };
  };

  /**
   * Award gold to an agent
   */
  const awardGold = async (
    companyId: string,
    agentId: string,
    amount: number,
    description?: string,
  ): Promise<Rt2AgentBalance> => {
    const now = new Date();

    // Upsert balance
    const existing = await db
      .select()
      .from(rt2GamificationAgentBalances)
      .where(
        and(
          eq(rt2GamificationAgentBalances.companyId, companyId),
          eq(rt2GamificationAgentBalances.agentId, agentId),
        ),
      );

    if (existing.length > 0) {
      const current = existing[0];
      await db
        .update(rt2GamificationAgentBalances)
        .set({
          balance: current.balance + amount,
          lifetimeEarned: current.lifetimeEarned + amount,
          updatedAt: now,
        })
        .where(eq(rt2GamificationAgentBalances.id, current.id));

      return {
        id: current.id,
        companyId: current.companyId,
        agentId: current.agentId,
        balance: current.balance + amount,
        lifetimeEarned: current.lifetimeEarned + amount,
        lifetimeSpent: current.lifetimeSpent,
        updatedAt: now,
        createdAt: current.createdAt,
      };
    }

    const insertResult = await db
      .insert(rt2GamificationAgentBalances)
      .values({
        companyId,
        agentId,
        balance: amount,
        lifetimeEarned: amount,
        lifetimeSpent: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const row = insertResult[0];
    return {
      id: row.id,
      companyId: row.companyId,
      agentId: row.agentId,
      balance: row.balance,
      lifetimeEarned: row.lifetimeEarned,
      lifetimeSpent: row.lifetimeSpent,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
    };
  };

  // -------------------------------------------------------------------------
  // Economy / Finance
  // -------------------------------------------------------------------------

  /**
   * Get token balance (company-level finance summary)
   */
  const getTokenBalance = async (companyId: string): Promise<Rt2TokenBalance> => {
    // Get from finance_events - credit = income, debit = expense
    const creditRows = await db
      .select({ total: sql<number>`COALESCE(SUM(${financeEvents.amountCents}), 0)` })
      .from(financeEvents)
      .where(
        and(
          eq(financeEvents.companyId, companyId),
          eq(financeEvents.direction, "credit"),
        ),
      );

    const debitRows = await db
      .select({ total: sql<number>`COALESCE(SUM(${financeEvents.amountCents}), 0)` })
      .from(financeEvents)
      .where(
        and(
          eq(financeEvents.companyId, companyId),
          eq(financeEvents.direction, "debit"),
        ),
      );

    const income = Number(creditRows[0]?.total ?? 0);
    const expenses = Number(debitRows[0]?.total ?? 0);
    const balanceCents = income - expenses;

    // For now, use a default monthly budget (could be from budget_policies)
    const monthlyBudgetCents = 1000000; // $10,000 default

    // Calculate spent this month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyDebitRows = await db
      .select({ total: sql<number>`COALESCE(SUM(${financeEvents.amountCents}), 0)` })
      .from(financeEvents)
      .where(
        and(
          eq(financeEvents.companyId, companyId),
          eq(financeEvents.direction, "debit"),
          sql`${financeEvents.createdAt} >= ${monthStart}`,
        ),
      );

    const spentThisMonthCents = Number(monthlyDebitRows[0]?.total ?? 0);

    return {
      companyId,
      balanceCents,
      monthlyBudgetCents,
      spentThisMonthCents,
    };
  };

  /**
   * Get transaction history
   */
  const getTransactionHistory = async (
    companyId: string,
    limit = 50,
  ): Promise<Rt2TransactionHistory> => {
    const rows = await db
      .select()
      .from(financeEvents)
      .where(eq(financeEvents.companyId, companyId))
      .orderBy(desc(financeEvents.createdAt))
      .limit(limit);

    const balanceRows = await db
      .select({ total: sql<number>`COALESCE(SUM(${financeEvents.amountCents}), 0)` })
      .from(financeEvents)
      .where(eq(financeEvents.companyId, companyId))
      .then((r) => Number(r[0]?.total ?? 0));

    return {
      companyId,
      transactions: rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        agentId: row.agentId,
        issueId: null,
        activityType: row.direction as Rt2XpActivityType,
        xpAmount: row.amountCents,
        balanceAfter: balanceRows,
        description: row.description,
        createdAt: row.createdAt,
      })),
      balance: balanceRows,
    };
  };

  /**
   * Get cost breakdown by agent/project/provider
   */
  const getCostBreakdown = async (companyId: string): Promise<Rt2CostBreakdown> => {
    const rows = await db
      .select({
        agentId: financeEvents.agentId,
        amount: financeEvents.amountCents,
      })
      .from(financeEvents)
      .where(
        and(
          eq(financeEvents.companyId, companyId),
          eq(financeEvents.direction, "debit"),
        ),
      );

    const byAgent: Record<string, number> = {};
    let totalCents = 0;

    for (const row of rows) {
      const agentKey = row.agentId ?? "unknown";
      byAgent[agentKey] = (byAgent[agentKey] ?? 0) + Number(row.amount);
      totalCents += Number(row.amount);
    }

    return {
      companyId,
      byAgent,
      byProject: {}, // Would need project tracking in finance_events
      byProvider: {}, // Would need provider tracking
      totalCents,
    };
  };

  return {
    getLeaderboard,
    getAgentScore,
    getAchievements,
    checkAchievements,
    awardXp,
    getXpHistory,
    getLevelHistory,
    getAgentBalance,
    awardGold,
    getTokenBalance,
    getTransactionHistory,
    getCostBreakdown,
  };
}

// Helper to map activity type to level trigger
function mapActivityToTrigger(activity: Rt2XpActivityType): Rt2LevelTrigger {
  switch (activity) {
    case "task_complete":
      return "task_complete";
    case "approval":
      return "approval";
    case "achievement_earned":
      return "achievement";
    default:
      return "manual";
  }
}

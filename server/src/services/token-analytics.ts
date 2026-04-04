import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents, costEvents, heartbeatRuns } from "@ironworksai/db";
import { DEFAULT_OUTPUT_TOKEN_LIMITS } from "@ironworksai/shared";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentTokenSummary {
  agentId: string;
  agentName: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  totalCost: number;
  runsCount: number;
  avgTokensPerRun: number;
}

export interface TokenWasteAnalysis {
  avgInputTokens: number;
  avgOutputTokens: number;
  cacheHitRate: number;
  estimatedWastePct: number;
  recommendations: string[];
}

export interface CompanyTokenSummary {
  companyId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  totalCost: number;
  totalRuns: number;
  avgTokensPerRun: number;
  agents: AgentTokenSummary[];
}

// ── Service ──────────────────────────────────────────────────────────────────

export function tokenAnalyticsService(db: Db) {
  /**
   * Get per-agent token usage summary for a period (default 30 days).
   */
  async function getAgentTokenSummary(
    agentId: string,
    periodDays = 30,
  ): Promise<AgentTokenSummary> {
    const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

    const [row] = await db
      .select({
        agentName: agents.name,
        totalInputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
        totalOutputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
        totalCacheTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::int`,
        totalCostCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        runsCount: sql<number>`count(distinct ${costEvents.heartbeatRunId})::int`,
      })
      .from(costEvents)
      .leftJoin(agents, eq(costEvents.agentId, agents.id))
      .where(and(eq(costEvents.agentId, agentId), gte(costEvents.occurredAt, since)))
      .groupBy(agents.name);

    const totalInput = Number(row?.totalInputTokens ?? 0);
    const totalOutput = Number(row?.totalOutputTokens ?? 0);
    const totalCache = Number(row?.totalCacheTokens ?? 0);
    const runs = Number(row?.runsCount ?? 0);
    const totalCostCents = Number(row?.totalCostCents ?? 0);

    return {
      agentId,
      agentName: row?.agentName ?? null,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCacheTokens: totalCache,
      totalCost: totalCostCents / 100,
      runsCount: runs,
      avgTokensPerRun: runs > 0 ? Math.round((totalInput + totalOutput) / runs) : 0,
    };
  }

  /**
   * Analyze an agent's recent runs for token waste patterns.
   */
  async function analyzeTokenWaste(
    agentId: string,
    companyId: string,
    periodDays = 30,
  ): Promise<TokenWasteAnalysis> {
    const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

    // Get per-run token data
    const runs = await db
      .select({
        runId: costEvents.heartbeatRunId,
        inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
        cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::int`,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.agentId, agentId),
          eq(costEvents.companyId, companyId),
          gte(costEvents.occurredAt, since),
        ),
      )
      .groupBy(costEvents.heartbeatRunId)
      .orderBy(desc(costEvents.heartbeatRunId))
      .limit(100);

    if (runs.length === 0) {
      return {
        avgInputTokens: 0,
        avgOutputTokens: 0,
        cacheHitRate: 0,
        estimatedWastePct: 0,
        recommendations: ["No runs found in the analysis period."],
      };
    }

    const totalInput = runs.reduce((sum, r) => sum + Number(r.inputTokens), 0);
    const totalOutput = runs.reduce((sum, r) => sum + Number(r.outputTokens), 0);
    const totalCached = runs.reduce((sum, r) => sum + Number(r.cachedInputTokens), 0);
    const avgInput = Math.round(totalInput / runs.length);
    const avgOutput = Math.round(totalOutput / runs.length);

    // Cache hit rate: cached tokens / (cached + non-cached input)
    const cacheHitRate = totalInput + totalCached > 0
      ? Number(((totalCached / (totalInput + totalCached)) * 100).toFixed(1))
      : 0;

    // Waste detection
    const recommendations: string[] = [];
    let wastePct = 0;

    // Check: output tokens consistently near max (verbose agent)
    const defaultCap = DEFAULT_OUTPUT_TOKEN_LIMITS.code_generation;
    const verboseRuns = runs.filter((r) => Number(r.outputTokens) > defaultCap * 0.8);
    const verboseRatio = verboseRuns.length / runs.length;
    if (verboseRatio > 0.5) {
      recommendations.push(
        `${Math.round(verboseRatio * 100)}% of runs produce output near the token cap. Consider breaking tasks into smaller units or adding conciseness instructions.`,
      );
      wastePct += verboseRatio * 15;
    }

    // Check: input tokens growing run-over-run (context bloat)
    if (runs.length >= 5) {
      const recentFive = runs.slice(0, 5).map((r) => Number(r.inputTokens));
      const olderFive = runs.slice(Math.max(0, runs.length - 5)).map((r) => Number(r.inputTokens));
      const recentAvg = recentFive.reduce((a, b) => a + b, 0) / recentFive.length;
      const olderAvg = olderFive.reduce((a, b) => a + b, 0) / olderFive.length;
      if (olderAvg > 0 && recentAvg > olderAvg * 1.5) {
        recommendations.push(
          `Input tokens grew ${Math.round((recentAvg / olderAvg - 1) * 100)}% between older and recent runs. Consider enabling session compaction or clearing stale context.`,
        );
        wastePct += 20;
      }
    }

    // Check: low cache hit rate
    if (cacheHitRate < 50 && totalInput > 10000) {
      recommendations.push(
        `Cache hit rate is ${cacheHitRate}%. Consider structuring prompts with stable prefixes to improve cache utilization.`,
      );
      wastePct += 10;
    }

    // Check: runs with 0 meaningful output (wasted calls)
    const emptyRuns = runs.filter((r) => Number(r.outputTokens) < 50);
    const emptyRatio = emptyRuns.length / runs.length;
    if (emptyRatio > 0.1) {
      recommendations.push(
        `${Math.round(emptyRatio * 100)}% of runs produced minimal output (< 50 tokens). Review heartbeat frequency or wake conditions.`,
      );
      wastePct += emptyRatio * 25;
    }

    if (recommendations.length === 0) {
      recommendations.push("Token usage patterns look healthy. No waste detected.");
    }

    return {
      avgInputTokens: avgInput,
      avgOutputTokens: avgOutput,
      cacheHitRate,
      estimatedWastePct: Math.min(100, Math.round(wastePct)),
      recommendations,
    };
  }

  /**
   * Get company-wide token summary aggregating all agents.
   */
  async function getCompanyTokenSummary(
    companyId: string,
    periodDays = 30,
  ): Promise<CompanyTokenSummary> {
    const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

    const agentRows = await db
      .select({
        agentId: costEvents.agentId,
        agentName: agents.name,
        totalInputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
        totalOutputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
        totalCacheTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::int`,
        totalCostCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        runsCount: sql<number>`count(distinct ${costEvents.heartbeatRunId})::int`,
      })
      .from(costEvents)
      .leftJoin(agents, eq(costEvents.agentId, agents.id))
      .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, since)))
      .groupBy(costEvents.agentId, agents.name)
      .orderBy(desc(sql`coalesce(sum(${costEvents.costCents}), 0)::int`));

    const agentSummaries: AgentTokenSummary[] = agentRows.map((row) => {
      const input = Number(row.totalInputTokens);
      const output = Number(row.totalOutputTokens);
      const cache = Number(row.totalCacheTokens);
      const runs = Number(row.runsCount);
      const costCents = Number(row.totalCostCents);
      return {
        agentId: row.agentId,
        agentName: row.agentName ?? null,
        totalInputTokens: input,
        totalOutputTokens: output,
        totalCacheTokens: cache,
        totalCost: costCents / 100,
        runsCount: runs,
        avgTokensPerRun: runs > 0 ? Math.round((input + output) / runs) : 0,
      };
    });

    const totalInput = agentSummaries.reduce((s, a) => s + a.totalInputTokens, 0);
    const totalOutput = agentSummaries.reduce((s, a) => s + a.totalOutputTokens, 0);
    const totalCache = agentSummaries.reduce((s, a) => s + a.totalCacheTokens, 0);
    const totalCost = agentSummaries.reduce((s, a) => s + a.totalCost, 0);
    const totalRuns = agentSummaries.reduce((s, a) => s + a.runsCount, 0);

    return {
      companyId,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCacheTokens: totalCache,
      totalCost,
      totalRuns,
      avgTokensPerRun: totalRuns > 0 ? Math.round((totalInput + totalOutput) / totalRuns) : 0,
      agents: agentSummaries,
    };
  }

  return {
    getAgentTokenSummary,
    analyzeTokenWaste,
    getCompanyTokenSummary,
  };
}

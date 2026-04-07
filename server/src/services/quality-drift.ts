import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents, approvals, issueApprovals } from "@ironworksai/db";
import { logger } from "../middleware/logger.js";

// ── Quality Drift Detection ───────────────────────────────────────────────
//
// Monitors quality gate approval scores over time per agent.
// A "quality gate" approval has type = 'quality_gate' and payload.score (1-10).
// Drift is flagged when the rolling average drops below 6 or declines 2+ points
// from the 20-run average.

export interface DriftResult {
  averageScore: number;
  trend: "improving" | "stable" | "declining";
  isDrifting: boolean;
  recentScores: number[];
}

export interface AgentDriftEntry {
  agentId: string;
  agentName: string;
  drift: DriftResult;
}

/**
 * Detect quality drift for a specific agent based on their last 20
 * quality gate approvals.
 */
export async function detectQualityDrift(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<DriftResult> {
  // Get the last 20 quality gate approvals linked to issues assigned to this agent
  const rows = await db
    .select({
      payload: approvals.payload,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .innerJoin(issueApprovals, eq(approvals.id, issueApprovals.approvalId))
    .where(
      and(
        eq(approvals.companyId, companyId),
        eq(approvals.type, "quality_gate"),
        eq(approvals.status, "approved"),
        // Filter to approvals linked to issues where the agent is assignee
        sql`EXISTS (
          SELECT 1 FROM issues
          WHERE issues.id = ${issueApprovals.issueId}
            AND issues.assignee_agent_id = ${agentId}
        )`,
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(20);

  if (rows.length === 0) {
    return { averageScore: 0, trend: "stable", isDrifting: false, recentScores: [] };
  }

  const scores = rows.map((r) => {
    const payload = r.payload as Record<string, unknown>;
    return typeof payload.score === "number" ? payload.score : 0;
  });

  const averageScore = scores.reduce((a, b) => a + b, 0) / scores.length;

  // Determine trend by comparing first half vs second half
  const halfPoint = Math.floor(scores.length / 2);
  let trend: "improving" | "stable" | "declining" = "stable";

  if (scores.length >= 4) {
    // scores[0] is most recent, so "recent half" is the first half
    const recentHalf = scores.slice(0, halfPoint);
    const olderHalf = scores.slice(halfPoint);

    const recentAvg = recentHalf.reduce((a, b) => a + b, 0) / recentHalf.length;
    const olderAvg = olderHalf.reduce((a, b) => a + b, 0) / olderHalf.length;

    const diff = recentAvg - olderAvg;
    if (diff >= 0.5) trend = "improving";
    else if (diff <= -0.5) trend = "declining";
  }

  // Flag as drifting if average < 6 or declining 2+ points
  const isDrifting =
    averageScore < 6 ||
    (scores.length >= 4 && (() => {
      const recentHalf = scores.slice(0, Math.floor(scores.length / 2));
      const olderHalf = scores.slice(Math.floor(scores.length / 2));
      const recentAvg = recentHalf.reduce((a, b) => a + b, 0) / recentHalf.length;
      const olderAvg = olderHalf.reduce((a, b) => a + b, 0) / olderHalf.length;
      return olderAvg - recentAvg >= 2;
    })());

  return {
    averageScore: Math.round(averageScore * 100) / 100,
    trend,
    isDrifting,
    recentScores: scores,
  };
}

/**
 * Run drift detection across all agents in a company.
 * Returns only agents that are flagged as drifting.
 */
export async function checkAllAgentDrift(
  db: Db,
  companyId: string,
): Promise<AgentDriftEntry[]> {
  const allAgents = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        sql`${agents.status} != 'terminated'`,
      ),
    );

  const driftingAgents: AgentDriftEntry[] = [];

  for (const agent of allAgents) {
    try {
      const drift = await detectQualityDrift(db, companyId, agent.id);
      if (drift.isDrifting) {
        driftingAgents.push({ agentId: agent.id, agentName: agent.name, drift });
      }
    } catch (err) {
      logger.warn({ err, agentId: agent.id }, "failed to check quality drift for agent");
    }
  }

  return driftingAgents;
}

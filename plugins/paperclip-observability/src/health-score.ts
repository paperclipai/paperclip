/**
 * Agent health scoring algorithm (0–100).
 *
 * Scoring dimensions:
 * - Heartbeat age (30 pts): <5min=30, 5-15min=15, >15min=0
 * - Error state (25 pts): not in error=25, status=error → 0
 * - Budget (25 pts): <80% util=25, 80-90%=15, >90%=5, exhausted=0
 * - Run success (20 pts): proportional to success rate in last 24h
 */

export interface HealthScoreInput {
  status: string;
  heartbeatAgeSec: number | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  /** Success rate in [0, 1]. Null if no runs in the window. */
  runSuccessRate: number | null;
}

export interface HealthScoreResult {
  score: number;
  healthStatus: "healthy" | "degraded" | "unhealthy";
  breakdown: {
    heartbeat: number;
    errorState: number;
    budget: number;
    runSuccess: number;
  };
}

export function computeHealthScore(input: HealthScoreInput): HealthScoreResult {
  // Heartbeat age (30 pts)
  let heartbeat = 0;
  if (input.heartbeatAgeSec != null) {
    if (input.heartbeatAgeSec < 300) {
      heartbeat = 30;
    } else if (input.heartbeatAgeSec <= 900) {
      heartbeat = 15;
    }
  }

  // Error state (25 pts)
  const errorState = input.status === "error" ? 0 : 25;

  // Budget (25 pts)
  let budget = 25;
  if (input.budgetMonthlyCents > 0) {
    const utilPct =
      (input.spentMonthlyCents / input.budgetMonthlyCents) * 100;
    if (utilPct >= 100) {
      budget = 0;
    } else if (utilPct > 90) {
      budget = 5;
    } else if (utilPct > 80) {
      budget = 15;
    }
  }

  // Run success (20 pts)
  let runSuccess = 0;
  if (input.runSuccessRate != null) {
    runSuccess = Math.round(input.runSuccessRate * 20);
  }

  const score = heartbeat + errorState + budget + runSuccess;

  let healthStatus: HealthScoreResult["healthStatus"];
  if (score >= 70) {
    healthStatus = "healthy";
  } else if (score >= 40) {
    healthStatus = "degraded";
  } else {
    healthStatus = "unhealthy";
  }

  return {
    score,
    healthStatus,
    breakdown: { heartbeat, errorState, budget, runSuccess },
  };
}

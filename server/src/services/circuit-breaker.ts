import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

/** Default thresholds if not configured per-agent */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG = {
  maxConsecutiveFailures: 5,
  maxConsecutiveNoProgress: 8,
  lookbackRuns: 10,
} as const;

export interface CircuitBreakerConfig {
  enabled: boolean;
  maxConsecutiveFailures: number;
  maxConsecutiveNoProgress: number;
  lookbackRuns: number;
}

export type BreakerTripReason = "consecutive_failures" | "consecutive_no_progress";

export interface CircuitBreakerResult {
  allowed: boolean;
  tripped: boolean;
  reason?: BreakerTripReason;
  detail?: string;
  consecutiveFailures: number;
  consecutiveNoProgress: number;
}

/**
 * Parse circuit breaker config from agent's runtimeConfig.
 * Defaults to enabled with standard thresholds.
 */
export function parseCircuitBreakerConfig(
  agent: typeof agents.$inferSelect,
): CircuitBreakerConfig {
  const rc = agent.runtimeConfig as Record<string, unknown> | null;
  const cb = rc?.circuitBreaker as Record<string, unknown> | undefined;

  if (cb?.enabled === false) {
    return { enabled: false, maxConsecutiveFailures: 0, maxConsecutiveNoProgress: 0, lookbackRuns: 0 };
  }

  return {
    enabled: cb?.enabled !== false, // enabled by default
    maxConsecutiveFailures:
      typeof cb?.maxConsecutiveFailures === "number"
        ? cb.maxConsecutiveFailures
        : DEFAULT_CIRCUIT_BREAKER_CONFIG.maxConsecutiveFailures,
    maxConsecutiveNoProgress:
      typeof cb?.maxConsecutiveNoProgress === "number"
        ? cb.maxConsecutiveNoProgress
        : DEFAULT_CIRCUIT_BREAKER_CONFIG.maxConsecutiveNoProgress,
    lookbackRuns:
      typeof cb?.lookbackRuns === "number"
        ? cb.lookbackRuns
        : DEFAULT_CIRCUIT_BREAKER_CONFIG.lookbackRuns,
  };
}

/**
 * Check whether the circuit breaker should trip for this agent.
 * Looks at the N most recent completed heartbeat runs.
 */
export async function checkCircuitBreaker(
  db: Db,
  agent: typeof agents.$inferSelect,
): Promise<CircuitBreakerResult> {
  const config = parseCircuitBreakerConfig(agent);

  if (!config.enabled) {
    return { allowed: true, tripped: false, consecutiveFailures: 0, consecutiveNoProgress: 0 };
  }

  // Fetch the most recent completed runs
  const recentRuns = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      usageJson: heartbeatRuns.usageJson,
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agent.id),
        eq(heartbeatRuns.companyId, agent.companyId),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(config.lookbackRuns);

  if (recentRuns.length === 0) {
    return { allowed: true, tripped: false, consecutiveFailures: 0, consecutiveNoProgress: 0 };
  }

  // Count consecutive failures from the most recent run backwards
  let consecutiveFailures = 0;
  for (const run of recentRuns) {
    if (run.status === "failed" || run.status === "error") {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  // Count consecutive no-progress runs (completed but with very low output tokens)
  let consecutiveNoProgress = 0;
  for (const run of recentRuns) {
    if (isNoProgressRun(run)) {
      consecutiveNoProgress++;
    } else {
      break;
    }
  }

  // Check if breaker should trip
  if (consecutiveFailures >= config.maxConsecutiveFailures) {
    return {
      allowed: false,
      tripped: true,
      reason: "consecutive_failures",
      detail: `${consecutiveFailures} consecutive failures (threshold: ${config.maxConsecutiveFailures})`,
      consecutiveFailures,
      consecutiveNoProgress,
    };
  }

  if (consecutiveNoProgress >= config.maxConsecutiveNoProgress) {
    return {
      allowed: false,
      tripped: true,
      reason: "consecutive_no_progress",
      detail: `${consecutiveNoProgress} consecutive no-progress runs (threshold: ${config.maxConsecutiveNoProgress})`,
      consecutiveFailures,
      consecutiveNoProgress,
    };
  }

  return {
    allowed: true,
    tripped: false,
    consecutiveFailures,
    consecutiveNoProgress,
  };
}

/**
 * Determine if a run made no meaningful progress.
 * A run is considered no-progress if it completed but produced very few output tokens.
 */
function isNoProgressRun(run: {
  status: string;
  usageJson: unknown;
  error: string | null;
}): boolean {
  // Failed runs are counted separately, not as no-progress
  if (run.status === "failed" || run.status === "error") return false;

  // Only evaluate completed/finished runs
  if (run.status !== "completed" && run.status !== "finished") return false;

  const usage = run.usageJson as Record<string, unknown> | null;
  if (!usage) return true; // no usage data at all = no progress

  const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;

  // Threshold: if agent produced fewer than 50 output tokens, it likely did nothing meaningful
  return outputTokens < 50;
}

/**
 * Log a circuit breaker trip to the activity log and pause the agent.
 */
export async function tripCircuitBreaker(
  db: Db,
  agent: typeof agents.$inferSelect,
  result: CircuitBreakerResult,
) {
  await logActivity(db, {
    companyId: agent.companyId,
    actorType: "system",
    actorId: "circuit-breaker",
    action: "circuit_breaker.tripped",
    entityType: "agent",
    entityId: agent.id,
    agentId: agent.id,
    details: {
      reason: result.reason,
      detail: result.detail,
      consecutiveFailures: result.consecutiveFailures,
      consecutiveNoProgress: result.consecutiveNoProgress,
    },
  });

  // Auto-pause the agent
  if (agent.status !== "paused" && agent.status !== "terminated") {
    await db
      .update(agents)
      .set({
        status: "paused",
        updatedAt: new Date(),
        metadata: {
          ...(agent.metadata as Record<string, unknown> | null ?? {}),
          pauseReason: "circuit_breaker",
          pauseDetail: result.detail,
          pausedAt: new Date().toISOString(),
        },
      })
      .where(eq(agents.id, agent.id));
  }
}

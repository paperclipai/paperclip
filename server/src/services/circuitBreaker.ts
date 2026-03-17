import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, heartbeatRuns } from "@paperclipai/db";
import { and, desc, sql } from "drizzle-orm";

export interface CircuitBreakerConfig {
  enabled: boolean;
  maxConsecutiveNoProgress: number;
  maxConsecutiveFailures: number;
  tokenVelocityMultiplier: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  maxConsecutiveNoProgress: 5,
  maxConsecutiveFailures: 3,
  tokenVelocityMultiplier: 3.0,
};

export interface CircuitBreakerState {
  consecutiveNoProgress: number;
  consecutiveFailures: number;
  rollingAvgInputTokens: number;
  tokenVelocityExceeded: boolean;
  isTripped: boolean;
}

export interface RunAnalysis {
  hasProgress: boolean;
  hasFailure: boolean;
  inputTokens: number;
}

export function circuitBreakerService(db: Db) {
  return {
    analyzeRun: async (agentId: string, runId: string): Promise<RunAnalysis> => {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);

      if (!run) {
        return { hasProgress: false, hasFailure: true, inputTokens: 0 };
      }

      const hasProgress = run.status === "succeeded";
      const hasFailure = run.status === "failed";
      const usageJson = run.usageJson as Record<string, unknown> | null;
      const inputTokens = typeof usageJson?.inputTokens === "number" ? usageJson.inputTokens : 0;

      return { hasProgress, hasFailure, inputTokens };
    },

    getCircuitBreakerState: async (
      agentId: string,
      config: CircuitBreakerConfig = DEFAULT_CONFIG,
    ): Promise<CircuitBreakerState> => {
      const recentRuns = await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          finishedAt: heartbeatRuns.finishedAt,
          usageJson: heartbeatRuns.usageJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId))
        .orderBy(desc(heartbeatRuns.finishedAt))
        .limit(Math.max(config.maxConsecutiveNoProgress, config.maxConsecutiveFailures) + 10);

      let consecutiveNoProgress = 0;
      let consecutiveFailures = 0;
      let rollingAvgInputTokens = 0;
      let firstSuccessOccurred = false;

      for (const run of recentRuns) {
        if (!run.finishedAt) continue;

        if (run.status === "failed") {
          if (!firstSuccessOccurred) {
            consecutiveFailures++;
          }
          consecutiveNoProgress++;
        } else if (run.status === "succeeded") {
          const usageJson = run.usageJson as Record<string, unknown> | null;
          const inputTokens = typeof usageJson?.inputTokens === "number" ? usageJson.inputTokens : 0;
          rollingAvgInputTokens += inputTokens;

          if (!firstSuccessOccurred) {
            firstSuccessOccurred = true;
          } else {
            consecutiveFailures = 0;
            consecutiveNoProgress = 0;
          }
        } else {
          consecutiveNoProgress++;
        }
      }

      const numSuccessfulRuns = recentRuns.filter(r => r.status === "succeeded").length;
      rollingAvgInputTokens = numSuccessfulRuns > 0 ? rollingAvgInputTokens / numSuccessfulRuns : 0;

      const latestRun = recentRuns[0];
      const latestUsageJson = latestRun?.usageJson as Record<string, unknown> | null;
      const latestInputTokens = typeof latestUsageJson?.inputTokens === "number" ? latestUsageJson.inputTokens : 0;

      let tokenVelocityExceeded = false;
      if (latestRun?.status === "succeeded" && numSuccessfulRuns > 1 && rollingAvgInputTokens > 0) {
        const avgExcludingLatest = numSuccessfulRuns > 1
          ? (rollingAvgInputTokens * numSuccessfulRuns - latestInputTokens) / (numSuccessfulRuns - 1)
          : rollingAvgInputTokens;
        tokenVelocityExceeded = latestInputTokens > avgExcludingLatest * config.tokenVelocityMultiplier;
      }

      const isTripped = config.enabled && (
        consecutiveNoProgress >= config.maxConsecutiveNoProgress ||
        consecutiveFailures >= config.maxConsecutiveFailures
      );

      return {
        consecutiveNoProgress,
        consecutiveFailures,
        rollingAvgInputTokens,
        tokenVelocityExceeded,
        isTripped,
      };
    },

    tripCircuitBreaker: async (
      agentId: string,
      companyId: string,
      reason: "no_progress" | "failures" | "token_velocity",
      details?: Record<string, unknown>,
    ): Promise<void> => {
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "system",
        action: "agent.circuit_breaker_tripped",
        entityType: "agent",
        entityId: agentId,
        agentId,
        details: {
          reason,
          ...details,
        },
      });

      await db
        .update(agents)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(agents.id, agentId));
    },

    checkAgentRunHealth: async (
      agentId: string,
      companyId: string,
      config: CircuitBreakerConfig = DEFAULT_CONFIG,
    ): Promise<{ shouldPause: boolean; reason?: string }> => {
      const service = circuitBreakerService(db);

      if (!config.enabled) {
        return { shouldPause: false };
      }

      const state = await service.getCircuitBreakerState(agentId, config);

      if (state.tokenVelocityExceeded) {
        await db.insert(activityLog).values({
          companyId,
          actorType: "system",
          actorId: "system",
          action: "agent.token_velocity_warning",
          entityType: "agent",
          entityId: agentId,
          agentId,
          details: {
            rollingAvgInputTokens: state.rollingAvgInputTokens,
            maxConsecutiveNoProgress: config.maxConsecutiveNoProgress,
            maxConsecutiveFailures: config.maxConsecutiveFailures,
          },
        });
      }

      if (state.isTripped) {
        if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
          await service.tripCircuitBreaker(agentId, companyId, "failures", {
            consecutiveFailures: state.consecutiveFailures,
            threshold: config.maxConsecutiveFailures,
          });
          return { shouldPause: true, reason: `Agent paused after ${state.consecutiveFailures} consecutive failures` };
        }

        if (state.consecutiveNoProgress >= config.maxConsecutiveNoProgress) {
          await service.tripCircuitBreaker(agentId, companyId, "no_progress", {
            consecutiveNoProgress: state.consecutiveNoProgress,
            threshold: config.maxConsecutiveNoProgress,
          });
          return { shouldPause: true, reason: `Agent paused after ${state.consecutiveNoProgress} runs with no progress` };
        }
      }

      return { shouldPause: false };
    },
  };
}

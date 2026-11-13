import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { AI_CONNECTION_POOL_WAIT_RETRY_REASON } from "../../modules/run-dispatch/index.js";
import { agentProviderLimitCooldown } from "../native-runtime/native-startup-retry.js";
import { parseObject } from "../../adapters/utils.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;

export interface ProviderLimitWaitDependencies {
  setRunStatusIfRunning: (runId: string, status: "cancelled", patch: {
    error: string; errorCode: string; finishedAt: Date; resultJson: Record<string, unknown>;
  }) => Promise<{ updated: boolean; run?: HeartbeatRun | null }>;
  setWakeupStatus: (wakeupRequestId: string | null | undefined, status: "cancelled", patch: { finishedAt: Date; error: string }) => Promise<unknown>;
  appendRunEvent: (run: HeartbeatRun, event: {
    eventType: string; stream: "system"; level: "warn"; message: string; payload: Record<string, unknown>;
  }) => Promise<unknown>;
  scheduleBoundedRetryForRun: (run: HeartbeatRun, agent: Agent, opts: {
    now: Date; retryReason: string; wakeReason: string; maxAttempts: number; delayMs: number;
  }) => Promise<{ outcome: string }>;
  releaseIssueExecutionAndPromote: (run: HeartbeatRun) => Promise<unknown>;
  finalizeAgentStatus: (agentId: string, outcome: "cancelled") => Promise<unknown>;
}

/** Holds new work while the agent's provider account is out of allowance. */
export function createProviderLimitWait(db: Db, deps: ProviderLimitWaitDependencies) {
  const {
    setRunStatusIfRunning, setWakeupStatus, appendRunEvent, scheduleBoundedRetryForRun,
    releaseIssueExecutionAndPromote, finalizeAgentStatus,
  } = deps;

  /**
   * An agent whose provider account recently reported an exhausted allowance
   * would fail new work the same way. Before any workspace or provider work,
   * hold the wake until the reported reset and retry it then. A manual run, a
   * recovering run, a conversation turn, and pool routing (which selects
   * another account) still start, so an operator can always test a repair.
   */
  async function deferRunForProviderLimit(
    run: HeartbeatRun,
    agent: Agent,
    options: { resumingAdmittedRun: boolean; conversation: boolean },
  ): Promise<boolean> {
    if (options.resumingAdmittedRun || options.conversation) return false;
    if (run.invocationSource === "on_demand" && run.triggerDetail === "manual") return false;
    if (parseObject(parseObject(agent.runtimeConfig).aiConnection).mode === "router") return false;
    const now = new Date();
    const cooldown = await agentProviderLimitCooldown(db, {
      companyId: run.companyId, agentId: run.agentId, runId: run.id, now,
    }).catch((err: unknown) => {
      // Missing evidence must not stop work; the provider still reports its own limit.
      logger.warn({ err, runId: run.id }, "provider limit evidence unavailable before dispatch");
      return null;
    });
    if (!cooldown) return false;
    const resetAt = cooldown.resetAt.toISOString();
    const message = `The provider usage limit for this agent is expected to reset at ${resetAt}${
      cooldown.resetReported ? "" : " (no reset time was reported, so Paperclip waits one hour)"
    }. Paperclip will start this work then.`;
    const cancelled = await setRunStatusIfRunning(run.id, "cancelled", {
      error: message, errorCode: "provider_limit_wait", finishedAt: now,
      resultJson: {
        executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false },
        providerLimitWait: {
          resetAt, resetReported: cooldown.resetReported, category: cooldown.category,
          sourceRunId: cooldown.sourceRunId, actionUrl: `/agents/${agent.id}/runtime`,
        },
        cancellation: {
          source: "control_plane", expected: true, initiator: { type: "system" },
          reason: "Waiting for the agent's provider usage limit to reset", recordedAt: now.toISOString(),
        },
        retryAt: resetAt,
      },
    });
    if (!cancelled.updated) return true;
    const deferred = cancelled.run ?? run;
    // The cancellation is committed. From here the wake must either gain its
    // retry or release its task lock; diagnostics never decide that.
    let scheduled = false;
    try {
      // Scheduling is idempotent per source run, so one more attempt is safe.
      for (let attempt = 1; attempt <= 2 && !scheduled; attempt += 1) {
        try {
          // Each wait is one retry at the reset; evidence expires within a day.
          const retry = await scheduleBoundedRetryForRun(deferred, agent, {
            now, retryReason: AI_CONNECTION_POOL_WAIT_RETRY_REASON, wakeReason: "provider_limit_retry",
            maxAttempts: (run.scheduledRetryAttempt ?? 0) + 1,
            delayMs: Math.max(1000, cooldown.resetAt.getTime() - now.getTime() + 1000),
          });
          scheduled = retry.outcome === "scheduled";
          if (!scheduled) break;
        } catch (err) {
          logger.warn({ err, runId: run.id, attempt }, "failed to schedule the provider limit retry");
        }
      }
      await appendRunEvent(deferred, {
        eventType: "lifecycle", stream: "system", level: "warn",
        message: scheduled
          ? `Waiting for the provider usage limit to reset at ${resetAt} before starting work`
          : `The provider usage limit resets at ${resetAt}; this wake could not schedule its retry and released the task`,
        payload: { resetAt, resetReported: cooldown.resetReported, category: cooldown.category, sourceRunId: cooldown.sourceRunId, retryScheduled: scheduled },
      }).catch((err: unknown) => logger.warn({ err, runId: run.id }, "failed to record the provider limit wait"));
      await setWakeupStatus(run.wakeupRequestId, "cancelled", { finishedAt: now, error: message })
        .catch((err: unknown) => logger.warn({ err, runId: run.id }, "failed to settle the provider limit wakeup"));
    } finally {
      try {
        if (!scheduled) await releaseIssueExecutionAndPromote(deferred);
      } finally {
        await finalizeAgentStatus(run.agentId, "cancelled");
      }
    }
    return true;
  }

  return { deferRunForProviderLimit };
}

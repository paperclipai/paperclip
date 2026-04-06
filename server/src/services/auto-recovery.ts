import { and, eq, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, agents } from "@paperclipai/db";
import { heartbeatService } from "./heartbeat.js";
import { issueRouterService } from "./issue-router.js";
import { agentMessageService } from "./agent-messages.js";

type HeartbeatService = ReturnType<typeof heartbeatService>;

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
const STALE_RUN_THRESHOLD_MS = 10 * 60 * 1000;

export function autoRecoveryService(db: Db, heartbeat: HeartbeatService) {
  const issueRouter = issueRouterService(db);
  const messaging = agentMessageService(db);

  return {
    async handleFailedRun(runId: string): Promise<boolean> {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);

      if (!run || run.status !== "failed") return false;

      const retryCount = run.processLossRetryCount;
      if (retryCount >= MAX_RETRIES) {
        await this.escalateFailure(run.agentId, run.companyId, runId, retryCount);
        return false;
      }

      const delayMs = RETRY_DELAYS_MS[retryCount] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;

      // NOTE: In-process setTimeout is NOT restart-safe. Stale cleanup will catch orphans.
      setTimeout(async () => {
        try {
          await heartbeat.wakeup(run.agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: `Auto-retry attempt ${retryCount + 1}/${MAX_RETRIES} for failed run ${runId}`,
            payload: { retryOfRunId: runId, retryCount: retryCount + 1 },
            requestedByActorType: "system",
            requestedByActorId: "auto-recovery",
          });
        } catch (err) {
          console.error(`[auto-recovery] Failed to schedule retry for run ${runId}:`, err);
        }
      }, delayMs);

      await db
        .update(heartbeatRuns)
        .set({
          processLossRetryCount: retryCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));

      return true;
    },

    async escalateFailure(
      agentId: string,
      companyId: string,
      runId: string,
      retryCount: number,
    ): Promise<void> {
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);

      if (!agent) return;

      const escalateToId = agent.reportsTo ?? (await issueRouter.getCeoAgentId(companyId));

      if (escalateToId && escalateToId !== agentId) {
        await messaging.send({
          companyId,
          fromAgentId: agentId,
          toAgentId: escalateToId,
          messageType: "escalation",
          subject: `Agent ${agent.name} failed after ${retryCount} retries`,
          body: `Agent "${agent.name}" has failed ${retryCount} times on run ${runId}. Manual intervention or task reassignment may be needed.`,
          metadata: { failedRunId: runId, retryCount },
        });
      }
    },

    async cleanupStaleRuns(): Promise<number> {
      const cutoff = new Date(Date.now() - STALE_RUN_THRESHOLD_MS);

      const staleRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.status, "running"),
            lt(heartbeatRuns.startedAt, cutoff),
          ),
        );

      for (const run of staleRuns) {
        await db
          .update(heartbeatRuns)
          .set({
            status: "failed",
            error: "Stale run detected — exceeded 10 minute timeout",
            errorCode: "STALE_RUN",
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));

        await this.handleFailedRun(run.id);
      }

      return staleRuns.length;
    },
  };
}

import { and, eq, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

const RUN_STALE_MINUTES_DEFAULT = 30;
const FALLBACK_ADAPTER = "opencode_local";

export interface StaleRunCleanupResult {
  scanned: number;
  forceFailed: string[];
  adapterSwitched: string[];
  commentsPosted: number;
}

export interface StaleRunCleanupConfig {
  staleMinutes?: number;
  dryRun?: boolean;
}

export async function performStaleRunCleanup(
  db: Db,
  issuesSvc: {
    addComment: (
      issueId: string,
      body: string,
      actor: { agentId?: string; userId?: string; runId?: string | null },
    ) => Promise<unknown>;
  },
  configOverrides?: StaleRunCleanupConfig,
): Promise<StaleRunCleanupResult> {
  const config: Required<StaleRunCleanupConfig> = {
    staleMinutes: configOverrides?.staleMinutes ?? RUN_STALE_MINUTES_DEFAULT,
    dryRun: configOverrides?.dryRun ?? false,
  };

  const staleThreshold = new Date(Date.now() - config.staleMinutes * 60 * 1000);

  const staleRuns = await db
    .select({
      run: heartbeatRuns,
      agent: agents,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(
      and(
        eq(heartbeatRuns.status, "running"),
        lte(heartbeatRuns.updatedAt, staleThreshold),
      ),
    );

  const results: StaleRunCleanupResult = {
    scanned: staleRuns.length,
    forceFailed: [],
    adapterSwitched: [],
    commentsPosted: 0,
  };

  for (const { run, agent } of staleRuns) {
    const issueId = await resolveIssueIdForRun(db, run.id);

    if (config.dryRun) {
      logger.info(
        { runId: run.id, agentId: agent.id },
        `[DryRun] Would force-fail stale run ${run.id}, reset agent ${run.agentId}`,
      );
      continue;
    }

    await db.transaction(async (tx) => {
      await tx
        .update(heartbeatRuns)
        .set({
          status: "failed",
          finishedAt: new Date(),
          error: `Stale-run cleanup: force-failed after ${config.staleMinutes}m inactivity`,
          errorCode: "stale_run_cleanup",
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));

      await tx
        .update(agents)
        .set({
          status: "idle",
          updatedAt: new Date(),
        })
        .where(eq(agents.id, run.agentId));
    });

    results.forceFailed.push(run.id);

    if (issueId) {
      try {
        await issuesSvc.addComment(
          issueId,
          `Stale-run cleanup: run \`${run.id}\` force-failed after ${config.staleMinutes}m inactivity. Agent \`${run.agentId}\` reset to \`idle\`.`,
          { agentId: undefined, userId: undefined, runId: null },
        );
        results.commentsPosted++;
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e), issueId, runId: run.id },
          "Failed to post cleanup comment",
        );
      }
    }

    const consecutiveErrors = resolveConsecutiveErrorCount(agent);
    if (agent.adapterType !== FALLBACK_ADAPTER && consecutiveErrors >= 3) {
      try {
        await db
          .update(agents)
          .set({
            adapterType: FALLBACK_ADAPTER,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agent.id));
        results.adapterSwitched.push(agent.id);

        if (issueId) {
          try {
            await issuesSvc.addComment(
              issueId,
              `Auto-recovery: agent \`${agent.id}\` (${agent.adapterType as string}) reached 3 consecutive errors and was switched to \`${FALLBACK_ADAPTER}\`.`,
          { agentId: undefined, userId: undefined, runId: null },
            );
            results.commentsPosted++;
          } catch (e) {
            logger.warn(
              { err: e instanceof Error ? e.message : String(e), issueId, agentId: agent.id },
              "Failed to post adapter-switch comment",
            );
          }
        }
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e), agentId: agent.id },
          "Failed to switch adapter for agent",
        );
      }
    }
  }

  if (results.forceFailed.length > 0) {
    logger.warn(
      {
        scanned: results.scanned,
        forceFailed: results.forceFailed,
        adapterSwitched: results.adapterSwitched,
        commentsPosted: results.commentsPosted,
      },
      "stale-run cleanup completed",
    );
  }

  return results;
}

async function resolveIssueIdForRun(
  db: Db,
  runId: string,
): Promise<string | null> {
  const rows = await db
    .select({ issueId: issues.id })
    .from(issues)
    .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
    .where(eq(heartbeatRuns.id, runId))
    .limit(1);

  if (rows[0]?.issueId) return rows[0].issueId;

  const runRows = await db
    .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .limit(1);

  const ctx = runRows[0]?.contextSnapshot;
  if (ctx && typeof ctx === "object" && !Array.isArray(ctx)) {
    const issueId = (ctx as Record<string, unknown>).issueId;
    if (typeof issueId === "string" && issueId) return issueId;
  }

  return null;
}

function resolveConsecutiveErrorCount(
  agent: typeof agents.$inferSelect,
): number {
  const meta = agent.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const val = (meta as Record<string, unknown>).consecutiveErrorCount;
    if (typeof val === "number" && Number.isFinite(val)) {
      return Math.max(0, val);
    }
  }
  return 0;
}

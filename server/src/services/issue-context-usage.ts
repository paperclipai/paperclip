import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import type { IssueContextUsage } from "@paperclipai/shared";

/**
 * Recent runs of the assignee searched for its newest usage report. The
 * usage lookups use `heartbeat_run_events_usage_item_run_idx`, so they read
 * only the few usage items of these runs.
 */
const RECENT_RUN_LIMIT = 3;

function count(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Matches the predicate of `heartbeat_run_events_usage_item_run_idx`. */
const usageItem = sql`${heartbeatRunEvents.eventType} = 'item.completed' and (${heartbeatRunEvents.payload} -> 'prpEvent' -> 'payload' ->> 'kind') = 'usage'`;
/** Matches the key expression of `heartbeat_run_events_compaction_session_idx`. */
const sessionIdSql = sql<string | null>`(${heartbeatRunEvents.payload} -> 'prpEvent' ->> 'normalizedSessionId')`;

/**
 * Reads the most recent provider-reported context occupancy for the current
 * agent session on a task. The current session is the one behind the
 * assignee's newest usage report: after a reassignment or a fresh session,
 * older readings are not returned. Returns null until that session reports a
 * context window.
 */
export async function issueContextUsage(
  db: Db,
  companyId: string,
  issue: { id: string; assigneeAgentId: string | null },
): Promise<IssueContextUsage | null> {
  if (!issue.assigneeAgentId) return null;
  const runs = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, issue.assigneeAgentId),
      or(eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id)),
    ))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(RECENT_RUN_LIMIT);
  if (runs.length === 0) return null;
  const runIds = runs.map((run) => run.id);

  const recentUsage = and(
    eq(heartbeatRunEvents.companyId, companyId),
    inArray(heartbeatRunEvents.runId, runIds),
    usageItem,
  );
  // The newest usage report names the current session.
  const [current] = await db
    .select({ sessionId: sessionIdSql })
    .from(heartbeatRunEvents)
    .where(recentUsage)
    .orderBy(desc(heartbeatRunEvents.createdAt), desc(heartbeatRunEvents.id))
    .limit(1);
  const sessionId = current?.sessionId ?? null;
  if (!sessionId) return null;

  const [latest] = await db
    .select({
      runId: heartbeatRunEvents.runId,
      agentId: heartbeatRunEvents.agentId,
      createdAt: heartbeatRunEvents.createdAt,
      usage: sql<unknown>`${heartbeatRunEvents.payload} -> 'prpEvent' -> 'payload' -> 'usage'`,
    })
    .from(heartbeatRunEvents)
    .where(and(
      recentUsage,
      sql`${sessionIdSql} = ${sessionId}`,
      sql`${heartbeatRunEvents.payload} -> 'prpEvent' -> 'payload' -> 'usage' ? 'context'`,
    ))
    .orderBy(desc(heartbeatRunEvents.createdAt), desc(heartbeatRunEvents.id))
    .limit(1);
  if (!latest) return null;
  const usage = record(latest.usage);
  const context = record(usage?.context);
  const usedTokens = count(context?.usedTokens);
  const windowTokens = count(context?.windowTokens);
  if (usedTokens === null || windowTokens === null || windowTokens < 1) return null;

  // Every compaction of the session, across all of its runs.
  const [compactions] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, companyId),
      eq(heartbeatRunEvents.eventType, "context.compacted"),
      sql`${sessionIdSql} = ${sessionId}`,
    ));

  const total = record(usage?.total);
  const inputTokens = count(total?.inputTokens) ?? 0;
  const cachedInputTokens = count(total?.cacheReadTokens) ?? count(total?.cachedInputTokens) ?? 0;
  const outputTokens = count(total?.outputTokens) ?? 0;
  const costUsd = count(total?.providerCostUsd);
  return {
    runId: latest.runId,
    agentId: latest.agentId,
    sessionId,
    usedTokens,
    windowTokens,
    observedAt: latest.createdAt.toISOString(),
    totals: inputTokens + outputTokens > 0 ? { inputTokens, cachedInputTokens, outputTokens } : null,
    costUsd: costUsd && costUsd > 0 ? costUsd : null,
    compactions: compactions?.count ?? 0,
  };
}

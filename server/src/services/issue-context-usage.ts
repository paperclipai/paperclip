import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import type { IssueContextUsage } from "@paperclipai/shared";

/**
 * Recent runs of the assignee searched for its current session. A session is
 * reused across consecutive runs, so a short window is enough and keeps the
 * event lookups bounded to a few runs.
 */
const RECENT_RUN_LIMIT = 3;

function count(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Reads the most recent provider-reported context occupancy for the current
 * agent session on a task. Only the assignee's newest session counts: after a
 * reassignment or a fresh session, older readings are not returned. Returns
 * null until that session reports a context window.
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
  const sessionIdSql = sql<string | null>`${heartbeatRunEvents.payload} -> 'prpEvent' ->> 'normalizedSessionId'`;

  // The newest session the assignee reported for this task.
  const [current] = await db
    .select({ sessionId: sessionIdSql })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, companyId),
      inArray(heartbeatRunEvents.runId, runIds),
      isNotNull(sessionIdSql),
    ))
    .orderBy(desc(heartbeatRunEvents.createdAt), desc(heartbeatRunEvents.id))
    .limit(1);
  const sessionId = current?.sessionId ?? null;
  if (!sessionId) return null;
  const inSession = sql`${sessionIdSql} = ${sessionId}`;

  const usagePayload = sql`${heartbeatRunEvents.payload} -> 'prpEvent' -> 'payload'`;
  const [latest] = await db
    .select({
      runId: heartbeatRunEvents.runId,
      agentId: heartbeatRunEvents.agentId,
      createdAt: heartbeatRunEvents.createdAt,
      usage: sql<unknown>`${usagePayload} -> 'usage'`,
    })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, companyId),
      inArray(heartbeatRunEvents.runId, runIds),
      eq(heartbeatRunEvents.eventType, "item.completed"),
      inSession,
      sql`${usagePayload} ->> 'kind' = 'usage'`,
      sql`${usagePayload} -> 'usage' ? 'context'`,
    ))
    .orderBy(desc(heartbeatRunEvents.createdAt), desc(heartbeatRunEvents.id))
    .limit(1);
  if (!latest) return null;
  const usage = record(latest.usage);
  const context = record(usage?.context);
  const usedTokens = count(context?.usedTokens);
  const windowTokens = count(context?.windowTokens);
  if (usedTokens === null || windowTokens === null || windowTokens < 1) return null;

  const [compactions] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, companyId),
      inArray(heartbeatRunEvents.runId, runIds),
      eq(heartbeatRunEvents.eventType, "context.compacted"),
      inSession,
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

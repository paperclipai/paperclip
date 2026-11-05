import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import type { IssueContextUsage } from "@paperclipai/shared";

/** Recent runs searched for the latest context measurement. */
const RECENT_RUN_LIMIT = 10;

function count(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Reads the most recent provider-reported context occupancy for a task's
 * agent session. Returns null until a harness reports a context window.
 */
export async function issueContextUsage(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<IssueContextUsage | null> {
  const runs = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      or(eq(heartbeatRuns.issueId, issueId), eq(heartbeatRuns.nativeIssueId, issueId)),
    ))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(RECENT_RUN_LIMIT);
  if (runs.length === 0) return null;
  const runIds = runs.map((run) => run.id);
  const usagePayload = sql`${heartbeatRunEvents.payload} -> 'prpEvent' -> 'payload'`;
  const [latest] = await db
    .select({
      runId: heartbeatRunEvents.runId,
      agentId: heartbeatRunEvents.agentId,
      createdAt: heartbeatRunEvents.createdAt,
      usage: sql<unknown>`${usagePayload} -> 'usage'`,
      sessionId: sql<string | null>`${heartbeatRunEvents.payload} -> 'prpEvent' ->> 'normalizedSessionId'`,
    })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, companyId),
      inArray(heartbeatRunEvents.runId, runIds),
      eq(heartbeatRunEvents.eventType, "item.completed"),
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
      latest.sessionId
        ? sql`${heartbeatRunEvents.payload} -> 'prpEvent' ->> 'normalizedSessionId' = ${latest.sessionId}`
        : sql`true`,
    ));

  const total = record(usage?.total);
  const inputTokens = count(total?.inputTokens) ?? 0;
  const cachedInputTokens = count(total?.cacheReadTokens) ?? count(total?.cachedInputTokens) ?? 0;
  const outputTokens = count(total?.outputTokens) ?? 0;
  const costUsd = count(total?.providerCostUsd);
  return {
    runId: latest.runId,
    agentId: latest.agentId,
    sessionId: latest.sessionId,
    usedTokens,
    windowTokens,
    observedAt: latest.createdAt.toISOString(),
    totals: inputTokens + outputTokens > 0 ? { inputTokens, cachedInputTokens, outputTokens } : null,
    costUsd: costUsd && costUsd > 0 ? costUsd : null,
    compactions: compactions?.count ?? 0,
  };
}

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { ACTIVE_HEARTBEAT_RUN_STATUSES_BLOCKING_DONE } from "@paperclipai/shared";
import { selectFreshestCloseGateRun } from "./issue-close-evidence.js";

const ACTIVE_HEARTBEAT_RUN_STATUSES_BLOCKING_DONE_LIST = [
  ...ACTIVE_HEARTBEAT_RUN_STATUSES_BLOCKING_DONE,
];

/** Minimal run shape the close gate needs; both callers already have a getter. */
export type CloseGateRunLookup = (
  runId: string,
) => Promise<{ id: string; status: string; startedAt?: Date | null; createdAt?: Date | null } | null | undefined>;

// TSMC-21479: extracted from routes/issues.ts so the heartbeat disposition path
// can resolve run context identically. The original took the whole heartbeat
// service, which would be a circular import here — it only ever called
// `getRun`, so that single function is injected instead.
export async function resolveIssueRunForCloseGate(
  db: Db,
  issue: { id: string; companyId: string; executionRunId?: string | null },
  getRun: CloseGateRunLookup,
  opts: { excludeRunId?: string | null } = {},
): Promise<{ id: string; status: string; startedAt: Date | null; createdAt: Date | null } | null> {
  const excludeRunId = opts.excludeRunId?.trim() || null;

  // §2 active-run block: prefer any OTHER active run scoped to this issue (TSBC-1585 class).
  // The caller's own live run must not self-block a terminal done transition —
  // agents routinely PATCH done as the last action before the adapter exits.
  // Self-exclusion is intentional here only; AC freshness below includes the actor.
  const activeRows = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, issue.companyId),
      inArray(heartbeatRuns.status, [...ACTIVE_HEARTBEAT_RUN_STATUSES_BLOCKING_DONE_LIST]),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
      excludeRunId ? sql`${heartbeatRuns.id} <> ${excludeRunId}` : undefined,
    ))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1);
  if (activeRows[0]) return activeRows[0];

  // §3 AC freshness (TSMC-19840 / TSMC-18738): latest issue-scoped run by startedAt
  // INCLUDING the actor close-out run. Excluding the actor forced freshness checks onto
  // older pack-delivery runs and false-tripped on later board "Acceptance:" prose.
  const latestRows = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, issue.companyId),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
    ))
    .orderBy(
      desc(sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt})`),
      desc(heartbeatRuns.createdAt),
    )
    .limit(1);
  const latestScoped = latestRows[0] ?? null;

  // Always consider the actor close-out run even when contextSnapshot.issueId is missing
  // or lags; prefer whichever candidate is fresher by startedAt/createdAt.
  let actorCandidate: {
    id: string;
    status: string;
    startedAt: Date | null;
    createdAt: Date | null;
  } | null = null;
  if (excludeRunId) {
    if (latestScoped?.id === excludeRunId) {
      actorCandidate = latestScoped;
    } else {
      const selfRun = await getRun(excludeRunId);
      if (selfRun) {
        actorCandidate = {
          id: selfRun.id,
          status: selfRun.status,
          startedAt: selfRun.startedAt ?? null,
          createdAt: selfRun.createdAt ?? null,
        };
      }
    }
  }

  const freshest = selectFreshestCloseGateRun({
    latestScoped,
    actorRun: actorCandidate,
  });
  if (freshest) {
    const toDate = (value: Date | string | null | undefined): Date | null => {
      if (value == null) return null;
      if (value instanceof Date) return value;
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    };
    return {
      id: freshest.id,
      status: freshest.status,
      startedAt: toDate(freshest.startedAt ?? null),
      createdAt: toDate(freshest.createdAt ?? null),
    };
  }

  // Last resort: pinned executionRunId (may be stale relative to a fresher actor run;
  // only reached when the issue-scoped index and actor lookup both miss).
  if (issue.executionRunId && issue.executionRunId !== excludeRunId) {
    const run = await getRun(issue.executionRunId);
    if (run) {
      return {
        id: run.id,
        status: run.status,
        startedAt: run.startedAt ?? null,
        createdAt: run.createdAt ?? null,
      };
    }
  }
  return null;
}
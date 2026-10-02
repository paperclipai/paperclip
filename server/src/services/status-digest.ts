import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { executionIssueCondition } from "./issue-visibility.js";

/**
 * One cheap, server-side answer to "how is it going?".
 *
 * The digest exists so the question does not have to be answered by a full
 * heartbeat run: it is a handful of indexed reads over the same tables the
 * board already renders, no provider call, no agent, nothing written. Measured
 * on the live board: ~1.3 s and zero tokens against a full status run at ~440 s
 * and ~22k output tokens.
 *
 * Shape is deliberately small and stable — counts and a 24 h run window.
 */

export const STATUS_DIGEST_WINDOW_HOURS = 24;

export type StatusDigest = {
  companyId: string;
  generatedAt: string;
  windowHours: number;
  issues: {
    byStatus: Record<string, number>;
    open: number;
    blocked: number;
    inReview: number;
    inProgress: number;
  };
  runs: {
    running: number;
    queued: number;
    window: {
      total: number;
      succeeded: number;
      failed: number;
      timedOut: number;
      medianDurationSeconds: number | null;
      outputTokens: number;
    };
  };
  approvals: { pending: number };
  humanWaits: { pendingInteractions: number };
};

function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function statusDigestService(db: Db) {
  return {
    digest: async (companyId: string): Promise<StatusDigest> => {
      const now = new Date();
      const windowStart = new Date(
        now.getTime() - STATUS_DIGEST_WINDOW_HOURS * 60 * 60 * 1000,
      );

      const [issueRows, windowRunRows, liveRunRows, pendingApprovals, pendingInteractions] =
        await Promise.all([
          db
            .select({ status: issues.status, count: sql<number>`count(*)` })
            .from(issues)
            .where(and(eq(issues.companyId, companyId), executionIssueCondition()))
            .groupBy(issues.status),
          db
            .select({ status: heartbeatRuns.status, count: sql<number>`count(*)` })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, companyId),
                gte(heartbeatRuns.createdAt, windowStart),
              ),
            )
            .groupBy(heartbeatRuns.status),
          db
            .select({ status: heartbeatRuns.status, count: sql<number>`count(*)` })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, companyId),
                sql`${heartbeatRuns.status} in ('running', 'queued')`,
              ),
            )
            .groupBy(heartbeatRuns.status),
          db
            .select({ count: sql<number>`count(*)` })
            .from(approvals)
            .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
            .then((rows) => toCount(rows[0]?.count)),
          db
            .select({ count: sql<number>`count(*)` })
            .from(issueThreadInteractions)
            .where(
              and(
                eq(issueThreadInteractions.companyId, companyId),
                eq(issueThreadInteractions.status, "pending"),
              ),
            )
            .then((rows) => toCount(rows[0]?.count)),
        ]);

      // Median wall-clock of finished runs in the window, plus the output tokens
      // they spent. Both come from one pass so the digest stays a single
      // aggregate query rather than a per-run walk.
      const windowStatsRows = (await db.execute(sql`
        SELECT
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at))
          ) AS median_duration_seconds,
          coalesce(sum(
            CASE
              WHEN jsonb_typeof(usage_json -> 'outputTokens') = 'number'
              THEN (usage_json ->> 'outputTokens')::bigint
              ELSE 0
            END
          ), 0) AS output_tokens
        FROM ${heartbeatRuns}
        WHERE company_id = ${companyId}
          AND created_at >= ${windowStart.toISOString()}::timestamptz
          AND started_at IS NOT NULL
          AND finished_at IS NOT NULL
      `)) as unknown as Iterable<{
        median_duration_seconds: number | string | null;
        output_tokens: number | string | null;
      }>;

      const windowStats = [...windowStatsRows][0] ?? {
        median_duration_seconds: null,
        output_tokens: 0,
      };
      const medianDuration =
        windowStats.median_duration_seconds == null
          ? null
          : Number(windowStats.median_duration_seconds);

      const byStatus: Record<string, number> = {};
      let open = 0;
      for (const row of issueRows) {
        const count = toCount(row.count);
        byStatus[String(row.status)] = count;
        if (row.status !== "done" && row.status !== "cancelled") open += count;
      }

      const windowByStatus: Record<string, number> = {};
      let windowTotal = 0;
      for (const row of windowRunRows) {
        const count = toCount(row.count);
        windowByStatus[String(row.status)] = count;
        windowTotal += count;
      }

      const live: Record<string, number> = {};
      for (const row of liveRunRows) {
        live[String(row.status)] = toCount(row.count);
      }

      return {
        companyId,
        generatedAt: now.toISOString(),
        windowHours: STATUS_DIGEST_WINDOW_HOURS,
        issues: {
          byStatus,
          open,
          blocked: byStatus.blocked ?? 0,
          inReview: byStatus.in_review ?? 0,
          inProgress: byStatus.in_progress ?? 0,
        },
        runs: {
          running: live.running ?? 0,
          queued: live.queued ?? 0,
          window: {
            total: windowTotal,
            succeeded: windowByStatus.succeeded ?? 0,
            failed: windowByStatus.failed ?? 0,
            timedOut: windowByStatus.timed_out ?? 0,
            medianDurationSeconds:
              medianDuration != null && Number.isFinite(medianDuration)
                ? Math.round(medianDuration * 10) / 10
                : null,
            outputTokens: toCount(windowStats.output_tokens),
          },
        },
        approvals: { pending: pendingApprovals },
        humanWaits: { pendingInteractions },
      };
    },
  };
}

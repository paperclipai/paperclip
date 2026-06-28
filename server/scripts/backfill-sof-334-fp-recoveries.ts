/**
 * SOF-334 backfill — auto-clear active 2026-06-28 false-positive recoveries.
 *
 * Before the disposition-freshness gate shipped, `successful_run_missing_state`
 * recovery actions fired on healthy runs due to the scan-vs-PATCH race. This
 * script re-evaluates each currently-active recovery against the new gate
 * logic and resolves the false positives as `restored` without waking VP-Eng.
 *
 * Safe to run repeatedly — it only acts on active recoveries whose cause is
 * `successful_run_missing_state` AND whose source run's disposition-freshness
 * gate would have suppressed the arm.
 *
 * Run with: npx tsx server/scripts/backfill-sof-334-fp-recoveries.ts
 *
 * NOT an agent action — runs server-side with full DB access, bypassing the
 * cross-agent PATCH auth boundary. The resolution is logged to
 * `recovery_actions` with a structured `resolutionNote` so future audits
 * can distinguish backfilled clearances from organic ones.
 */

import { and, eq, isNull, gt, or, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";

interface BackfillStats {
  scanned: number;
  cleared: number;
  skippedGateMiss: number;
  skippedAlreadyResolved: number;
  errors: Array<{ recoveryActionId: string; error: string }>;
}

async function isDispositionAfterRunFinished(
  db: Db,
  input: { companyId: string; issueId: string; assigneeAgentId: string; runFinishedAt: Date; runId: string },
): Promise<boolean> {
  const row = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.authorAgentId, input.assigneeAgentId),
        gt(issueComments.createdAt, input.runFinishedAt),
        or(isNull(issueComments.createdByRunId), ne(issueComments.createdByRunId, input.runId)),
      ),
    )
    .limit(1);
  return row.length > 0;
}

async function resolveAsFalsePositive(
  db: Db,
  input: { recoveryActionId: string; resolutionNote: string },
): Promise<void> {
  await db
    .update(issueRecoveryActions)
    .set({
      status: "resolved",
      outcome: "restored",
      resolutionNote: input.resolutionNote,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(issueRecoveryActions.id, input.recoveryActionId));
}

export async function backfillSof334FalsePositiveRecoveries(db: Db): Promise<BackfillStats> {
  const stats: BackfillStats = {
    scanned: 0,
    cleared: 0,
    skippedGateMiss: 0,
    skippedAlreadyResolved: 0,
    errors: [],
  };

  // Pull all currently-active recoveries whose cause is the race-prone one.
  const activeRecoveries = await db
    .select({
      id: issueRecoveryActions.id,
      companyId: issueRecoveryActions.companyId,
      sourceIssueId: issueRecoveryActions.sourceIssueId,
      cause: issueRecoveryActions.cause,
      evidence: issueRecoveryActions.evidence,
      createdAt: issueRecoveryActions.createdAt,
    })
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.status, "active"),
        eq(issueRecoveryActions.cause, "successful_run_missing_state"),
      ),
    );

  for (const rec of activeRecoveries) {
    stats.scanned += 1;
    try {
      // Only act on recoveries created on 2026-06-28 (the day the race loop
      // was confirmed and the SOF-334 ticket filed). This bounds the blast
      // radius of the backfill.
      if (!rec.createdAt.toISOString().startsWith("2026-06-28")) {
        stats.skippedAlreadyResolved += 1;
        continue;
      }

      // Find the source run from the evidence blob (the recovery records the
      // sourceRunId when it arms).
      const evidence = (rec.evidence ?? {}) as { sourceRunId?: string };
      const sourceRunId = evidence.sourceRunId;
      if (!sourceRunId) {
        stats.skippedGateMiss += 1;
        continue;
      }

      const run = await db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          finishedAt: heartbeatRuns.finishedAt,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, sourceRunId))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!run || !run.finishedAt) {
        stats.skippedGateMiss += 1;
        continue;
      }

      const issue = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(eq(issues.id, rec.sourceIssueId))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!issue || !issue.assigneeAgentId) {
        stats.skippedGateMiss += 1;
        continue;
      }

      const gateMatches = await isDispositionAfterRunFinished(db, {
        companyId: rec.companyId,
        issueId: rec.sourceIssueId,
        assigneeAgentId: issue.assigneeAgentId,
        runFinishedAt: run.finishedAt,
        runId: run.id,
      });

      if (!gateMatches) {
        stats.skippedGateMiss += 1;
        continue;
      }

      await resolveAsFalsePositive(db, {
        recoveryActionId: rec.id,
        resolutionNote:
          "SOF-334 backfill: disposition-freshness gate would have suppressed this recovery " +
          "(agent posted disposition after run completed). Auto-cleared without VP-Eng wake.",
      });
      stats.cleared += 1;
    } catch (err) {
      stats.errors.push({
        recoveryActionId: rec.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return stats;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL env var is required");
    process.exit(2);
  }
  const db = createDb(databaseUrl);
  const stats = await backfillSof334FalsePositiveRecoveries(db);
  console.log(JSON.stringify(stats, null, 2));
  if (stats.errors.length > 0) {
    process.exit(1);
  }
}
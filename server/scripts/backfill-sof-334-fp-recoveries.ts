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

import { and, eq, isNull, gt, gte, or, ne } from "drizzle-orm";
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
  clearedByInPlaceInclusion: number;
  clearedByPostRunInclusion: number;
  skippedGateMiss: number;
  skippedAlreadyResolved: number;
  errors: Array<{ recoveryActionId: string; error: string }>;
}

type GateInclusion = "comment_post_run" | "in_place_status_transition";

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

// GGU-SOF-549: second inclusion path for the SOF-334 disposition-freshness
// gate. Catches the SOF-69 15-flip shape where the assignee's disposition
// PATCH+comment lands INSIDE the run window (createdByRunId = run.id AND
// createdAt within [run.startedAt, run.finishedAt]). We pair it with the
// status-transition proxy: the issue must have moved AWAY FROM `in_progress`
// during the run window. A real disposition is the assignee choosing a final
// state (done, in_review, blocked, etc.); pure progress-note comments like
// the run-summary auto-extracted from `adapterResult.summary` or
// workspace-ready leave the status alone and are bookkeeping, not a
// disposition.
async function isInPlaceDispositionWithStatusTransition(
  db: Db,
  input: { companyId: string; issueId: string; assigneeAgentId: string; runId: string; runStartedAt: Date },
): Promise<boolean> {
  const [commentRow, issueRow] = await Promise.all([
    db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, input.companyId),
          eq(issueComments.issueId, input.issueId),
          eq(issueComments.authorAgentId, input.assigneeAgentId),
          eq(issueComments.createdByRunId, input.runId),
          gte(issueComments.createdAt, input.runStartedAt),
        ),
      )
      .limit(1),
    db
      .select({ updatedAt: issues.updatedAt, status: issues.status })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .limit(1),
  ]);
  if (commentRow.length === 0) return false;
  const issue = issueRow[0];
  if (!issue?.updatedAt || !issue?.status) return false;
  if (issue.status === "in_progress") return false;
  return issue.updatedAt >= input.runStartedAt;
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
    clearedByInPlaceInclusion: 0,
    clearedByPostRunInclusion: 0,
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
          startedAt: heartbeatRuns.startedAt,
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

      // GGU-SOF-549: try both inclusion paths. The v1 SOF-334 path catches
      // post-run comments (createdAt > finishedAt, not by source run). The
      // SOF-549 path catches in-place comments (createdByRunId = run.id,
      // within run window) paired with PATCH motion. Try the stronger v1
      // signal first so the resolution note reflects the original gate; if
      // only the SOF-549 inclusion matches, fall back to its note.
      let inclusion: GateInclusion | null = null;
      if (
        await isDispositionAfterRunFinished(db, {
          companyId: rec.companyId,
          issueId: rec.sourceIssueId,
          assigneeAgentId: issue.assigneeAgentId,
          runFinishedAt: run.finishedAt,
          runId: run.id,
        })
      ) {
        inclusion = "comment_post_run";
      } else if (
        run.startedAt &&
        (await isInPlaceDispositionWithStatusTransition(db, {
          companyId: rec.companyId,
          issueId: rec.sourceIssueId,
          assigneeAgentId: issue.assigneeAgentId,
          runId: run.id,
          runStartedAt: run.startedAt,
        }))
      ) {
        inclusion = "in_place_status_transition";
      }

      if (!inclusion) {
        stats.skippedGateMiss += 1;
        continue;
      }

      const note =
        inclusion === "comment_post_run"
          ? "SOF-334 backfill: disposition-freshness gate would have suppressed this recovery " +
            "(agent posted disposition after run completed). Auto-cleared without VP-Eng wake."
          : "SOF-549 backfill: in-place disposition inclusion would have suppressed this recovery " +
            "(agent posted disposition comment + PATCHed issue inside run window). Auto-cleared without VP-Eng wake.";

      await resolveAsFalsePositive(db, {
        recoveryActionId: rec.id,
        resolutionNote: note,
      });
      stats.cleared += 1;
      if (inclusion === "comment_post_run") stats.clearedByPostRunInclusion += 1;
      else stats.clearedByInPlaceInclusion += 1;
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
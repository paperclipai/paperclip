import { and, eq, isNull, lte, sql as drizzleSql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  verificationEscalations,
  verificationRuns,
  issues,
  type VerificationEscalation,
} from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";

/**
 * Verification escalation ladder.
 *
 * When a verification run returns `failed` (not `unavailable`), the gate opens a
 * verification_escalations row. The sweeper walks open rows on each tick and advances the
 * rung based on elapsed time since creation and the issue priority.
 *
 * Rungs (normal priority):
 *   0 — @assignee, status forced to in_progress (set by gate at creation time)
 *   1 — +30m: @manager (role-based: CTO/CMO/CPO/CEO)
 *   2 — +2h:  @CEO
 *   3 — +4h:  board dashboard + Slack/Discord alert
 *   4+ — every +4h: repeat board alert
 *
 * Urgent priority: 10m / 30m / 1h / repeat
 * Low priority:    4h / 12h / 24h / repeat
 * Incident priority: no escalation — handled by auto-revert (Phase 6)
 *
 * Rules:
 * - Escalation only for confirmed `failed` results, never `unavailable`
 * - Escalation @mentions via synthetic issue comment, does NOT reassign
 * - Passing verification cancels the ladder (sets resolved_at)
 * - Board override halts the ladder at any rung
 * - Reverts (incident priority) mark resolution: 'reverted'
 */

type Priority = "urgent" | "normal" | "low" | "incident";

interface RungConfig {
  rung: number;
  elapsedMs: number;
  activity: string;
  /** Comment template — keep short; the real failure summary is already in the issue */
  comment: (issueIdentifier: string) => string;
}

const NORMAL_LADDER: RungConfig[] = [
  {
    rung: 1,
    elapsedMs: 30 * 60 * 1000,
    activity: "issue.verification_escalated_to_manager",
    comment: (id) =>
      `🔔 Verification for ${id} has been failing for 30 minutes. Assignee should investigate or escalate to their manager.`,
  },
  {
    rung: 2,
    elapsedMs: 2 * 60 * 60 * 1000,
    activity: "issue.verification_escalated_to_ceo",
    comment: (id) =>
      `⚠️ Verification for ${id} has been failing for 2 hours. CEO escalation: this issue is stuck and needs attention.`,
  },
  {
    rung: 3,
    elapsedMs: 4 * 60 * 60 * 1000,
    activity: "issue.verification_escalated_to_board",
    comment: (id) =>
      `🚨 Verification for ${id} has been failing for 4 hours. BOARD ESCALATION: engineering leadership needs to intervene or override.`,
  },
];

const URGENT_LADDER: RungConfig[] = [
  { rung: 1, elapsedMs: 10 * 60 * 1000, activity: "issue.verification_escalated_to_manager", comment: (id) => `🔔 URGENT ${id}: 10min verification failure.` },
  { rung: 2, elapsedMs: 30 * 60 * 1000, activity: "issue.verification_escalated_to_ceo", comment: (id) => `⚠️ URGENT ${id}: 30min verification failure — CEO escalation.` },
  { rung: 3, elapsedMs: 60 * 60 * 1000, activity: "issue.verification_escalated_to_board", comment: (id) => `🚨 URGENT ${id}: 1h verification failure — BOARD ESCALATION.` },
];

const LOW_LADDER: RungConfig[] = [
  { rung: 1, elapsedMs: 4 * 60 * 60 * 1000, activity: "issue.verification_escalated_to_manager", comment: (id) => `🔔 ${id}: 4h verification failure.` },
  { rung: 2, elapsedMs: 12 * 60 * 60 * 1000, activity: "issue.verification_escalated_to_ceo", comment: (id) => `⚠️ ${id}: 12h verification failure — CEO escalation.` },
  { rung: 3, elapsedMs: 24 * 60 * 60 * 1000, activity: "issue.verification_escalated_to_board", comment: (id) => `🚨 ${id}: 24h verification failure — BOARD ESCALATION.` },
];

function getLadder(priority: Priority): RungConfig[] {
  if (priority === "urgent") return URGENT_LADDER;
  if (priority === "low") return LOW_LADDER;
  return NORMAL_LADDER;
}

export interface EscalationSweeperResult {
  advanced: number;
  repeated: number;
  errors: number;
}

/**
 * Creates a verification_escalations row when a verification_runs row transitions to `failed`.
 * Called from the route handler or worker after a failing run lands.
 */
export async function openEscalation(
  db: Db,
  input: {
    issueId: string;
    verificationRunId: string;
  },
): Promise<VerificationEscalation> {
  // Check if one already exists for this run — don't double up
  const existing = await db
    .select()
    .from(verificationEscalations)
    .where(eq(verificationEscalations.verificationRunId, input.verificationRunId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return existing;

  const [row] = await db
    .insert(verificationEscalations)
    .values({
      issueId: input.issueId,
      verificationRunId: input.verificationRunId,
      currentRung: 0,
      nextRungAt: new Date(Date.now() + NORMAL_LADDER[0].elapsedMs),
    })
    .returning();
  return row;
}

/**
 * Marks the escalation resolved (passing verification, board override, or revert).
 */
export async function resolveEscalation(
  db: Db,
  issueId: string,
  resolution: "passed" | "overridden" | "reverted",
): Promise<void> {
  await db
    .update(verificationEscalations)
    .set({
      resolvedAt: new Date(),
      resolution,
    })
    .where(
      and(
        eq(verificationEscalations.issueId, issueId),
        isNull(verificationEscalations.resolvedAt),
      ),
    );
}

/**
 * Walks open escalations whose nextRungAt has passed and advances them.
 *
 * Intentionally keeps the SQL shape simple — no joins. We fetch open rows, then for each row
 * look up the issue's priority and advance the ladder. This is O(n) in open escalations which
 * should always be a small number (every open escalation is a failing issue someone is working on).
 */
export async function runEscalationSweeper(db: Db): Promise<EscalationSweeperResult> {
  const now = new Date();
  const openRows = await db
    .select()
    .from(verificationEscalations)
    .where(
      and(
        isNull(verificationEscalations.resolvedAt),
        lte(verificationEscalations.nextRungAt, now),
      ),
    )
    .limit(50);

  let advanced = 0;
  let repeated = 0;
  let errors = 0;

  for (const row of openRows) {
    try {
      // Load the issue to get priority + identifier + companyId
      const issue = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          companyId: issues.companyId,
          priority: issues.priority,
        })
        .from(issues)
        .where(eq(issues.id, row.issueId))
        .limit(1)
        .then((r) => r[0] ?? null);

      if (!issue) {
        logger.warn({ escalationId: row.id, issueId: row.issueId }, "escalation references missing issue; skipping");
        continue;
      }

      // Incident priority is handled by auto-revert (Phase 6), not by this ladder.
      if (issue.priority === "incident") continue;

      const priority: Priority =
        issue.priority === "urgent" ? "urgent" : issue.priority === "low" ? "low" : "normal";
      const ladder = getLadder(priority);
      const createdMs = new Date(row.createdAt).getTime();
      const elapsedMs = now.getTime() - createdMs;

      // Find the highest rung whose elapsedMs threshold has been crossed
      let targetRung = row.currentRung;
      for (const rungCfg of ladder) {
        if (elapsedMs >= rungCfg.elapsedMs && rungCfg.rung > targetRung) {
          targetRung = rungCfg.rung;
        }
      }

      // Past the last rung: repeat the board alert every 4h (normal) / 1h (urgent) / 24h (low).
      const pastLastRung = targetRung >= ladder.length;
      let nextDelayMs: number;
      let activity: string;
      let comment: string;
      let rungToRecord: number;

      if (pastLastRung) {
        // Repeat cadence: keep rung pinned at the last rung, use the last rung's comment
        const repeatMs = priority === "urgent" ? 60 * 60 * 1000 : priority === "low" ? 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
        nextDelayMs = repeatMs;
        const last = ladder[ladder.length - 1];
        activity = last.activity;
        comment = `${last.comment(issue.identifier ?? issue.id)} (repeat alert)`;
        rungToRecord = ladder.length; // keep advancing for observability
        repeated += 1;
      } else {
        // Advance to the target rung
        const rungCfg = ladder.find((r) => r.rung === targetRung) ?? ladder[0];
        activity = rungCfg.activity;
        comment = rungCfg.comment(issue.identifier ?? issue.id);
        rungToRecord = targetRung;
        const nextRungCfg = ladder.find((r) => r.rung === targetRung + 1);
        nextDelayMs = nextRungCfg
          ? nextRungCfg.elapsedMs - elapsedMs
          : priority === "urgent" ? 60 * 60 * 1000 : priority === "low" ? 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
        advanced += 1;
      }

      // Post the escalation activity event. We do NOT reassign the issue — just log + alert.
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: "verification-escalation-sweeper",
        action: activity,
        entityType: "issue",
        entityId: issue.id,
        details: {
          escalationId: row.id,
          verificationRunId: row.verificationRunId,
          rung: rungToRecord,
          elapsedMs,
          comment,
          priority,
        },
      });

      // Persist the advance
      const updateFields: Partial<VerificationEscalation> = {
        currentRung: rungToRecord,
        nextRungAt: new Date(now.getTime() + nextDelayMs),
      };
      if (rungToRecord >= 1 && !row.escalatedToManagerAt) {
        updateFields.escalatedToManagerAt = now;
      }
      if (rungToRecord >= 2 && !row.escalatedToCeoAt) {
        updateFields.escalatedToCeoAt = now;
      }
      if (rungToRecord >= 3 && !row.escalatedToBoardAt) {
        updateFields.escalatedToBoardAt = now;
      }
      await db
        .update(verificationEscalations)
        .set(updateFields)
        .where(eq(verificationEscalations.id, row.id));
    } catch (err) {
      errors += 1;
      logger.error({ err, escalationId: row.id }, "escalation sweeper error");
    }
  }

  return { advanced, repeated, errors };
}

/**
 * Housekeeping: when a new passing verification run lands for an issue, close any open
 * escalations. Called from the worker (Phase 4+) when recording a passing run.
 *
 * Returns the number of escalations closed.
 */
export async function cancelOpenEscalationsForIssue(db: Db, issueId: string): Promise<number> {
  const result = await db
    .update(verificationEscalations)
    .set({
      resolvedAt: new Date(),
      resolution: "passed",
    })
    .where(
      and(
        eq(verificationEscalations.issueId, issueId),
        isNull(verificationEscalations.resolvedAt),
      ),
    )
    .returning({ id: verificationEscalations.id });
  return result.length;
}

/**
 * Dashboard query: lists open escalations with associated issue + run details.
 * Used by the /verification-failures UI (Phase 4b).
 */
export async function listOpenEscalations(db: Db, companyId: string) {
  return db
    .select({
      escalationId: verificationEscalations.id,
      issueId: issues.id,
      issueIdentifier: issues.identifier,
      issueTitle: issues.title,
      issuePriority: issues.priority,
      verificationRunId: verificationEscalations.verificationRunId,
      verificationRunStatus: verificationRuns.status,
      failureSummary: verificationRuns.failureSummary,
      traceAssetId: verificationRuns.traceAssetId,
      currentRung: verificationEscalations.currentRung,
      nextRungAt: verificationEscalations.nextRungAt,
      createdAt: verificationEscalations.createdAt,
    })
    .from(verificationEscalations)
    .innerJoin(issues, eq(verificationEscalations.issueId, issues.id))
    .innerJoin(
      verificationRuns,
      eq(verificationEscalations.verificationRunId, verificationRuns.id),
    )
    .where(
      and(
        isNull(verificationEscalations.resolvedAt),
        eq(issues.companyId, companyId),
      ),
    )
    .orderBy(drizzleSql`${verificationEscalations.nextRungAt} ASC`)
    .limit(100);
}

import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, routines, routineTriggers } from "@paperclipai/db";
import { nextCronTickFromExpression } from "./cron.js";
import { issueService } from "./issues.js";
import { logger } from "../middleware/logger.js";

const R1_THRESHOLD_MS = 72 * 60 * 60 * 1000;
const GC_BATCH_SIZE = 200;

const GC_PAUSED_STATUSES = ["paused", "archived"];

export interface RoutineGcResult {
  dryRun: boolean;
  r1Cancelled: number;
  r2Cancelled: number;
  affectedRoutines: number;
}

/**
 * Compute the minimum firing interval (in hours) for a cron expression by
 * sampling consecutive ticks over a 7-day window. Returns 24 as a safe fallback.
 */
function computeMinCronIntervalHours(expression: string): number {
  const now = new Date();
  let prev: Date | null = null;
  let minGapMs = Infinity;
  const windowEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  let cursor = new Date(now);

  for (let i = 0; i < 10_000; i++) {
    const tick = nextCronTickFromExpression(expression, cursor);
    if (!tick || tick >= windowEnd) break;
    if (prev !== null) {
      const gap = tick.getTime() - prev.getTime();
      if (gap < minGapMs) minGapMs = gap;
    }
    prev = tick;
    cursor = tick;
  }

  if (!Number.isFinite(minGapMs)) return 24;
  return Math.max(1, minGapMs / (60 * 60 * 1000));
}

export function routineGcService(db: Db) {
  const issueSvc = issueService(db);
  const isDryRun = process.env.GC_DRY_RUN === "true";

  async function postAuditComment(
    parentIssueId: string | null,
    routineId: string,
    routineTitle: string,
    rule: "R1" | "R2",
    count: number,
    oldestAgeHours: number,
  ) {
    if (!parentIssueId) return;
    try {
      const body = [
        `**GC audit (${rule})** — routine \`${routineTitle}\``,
        "",
        `- Issues cancelled: **${count}**`,
        `- Rule: ${rule === "R1" ? "routine paused/archived (72h threshold)" : "stale scan backlog (2× interval threshold)"}`,
        `- Oldest cancelled issue age: **${Math.round(oldestAgeHours)}h**`,
        isDryRun ? "\n_(dry-run — no changes applied)_" : "",
      ].filter((l) => l !== undefined).join("\n");
      await issueSvc.addComment(parentIssueId, body, { agentId: undefined, userId: undefined });
    } catch (err) {
      logger.warn({ err, routineId }, "routine-gc: failed to post audit comment");
    }
  }

  async function runGc(): Promise<RoutineGcResult> {
    const now = new Date();
    let r1Cancelled = 0;
    let r2Cancelled = 0;
    const affectedRoutineIds = new Set<string>();

    // ── R1: paused/archived routines — todo issues older than 72h ──────────
    const r1Cutoff = new Date(now.getTime() - R1_THRESHOLD_MS);

    const r1Rows = await db
      .select({
        issueId: issues.id,
        issueCreatedAt: issues.createdAt,
        routineId: routines.id,
        routineTitle: routines.title,
        parentIssueId: routines.parentIssueId,
      })
      .from(issues)
      .innerJoin(routines, and(
        eq(routines.id, sql`${issues.originId}::uuid`),
        inArray(routines.status, GC_PAUSED_STATUSES),
      ))
      .where(
        and(
          eq(issues.originKind, "routine_execution"),
          eq(issues.status, "todo"),
          lt(issues.createdAt, r1Cutoff),
        ),
      )
      .limit(GC_BATCH_SIZE);

    if (r1Rows.length > 0) {
      const byRoutine = new Map<string, typeof r1Rows>();
      for (const row of r1Rows) {
        const group = byRoutine.get(row.routineId) ?? [];
        group.push(row);
        byRoutine.set(row.routineId, group);
      }

      for (const [routineId, rows] of byRoutine.entries()) {
        const oldestAgeMs = now.getTime() - Math.min(...rows.map((r) => r.issueCreatedAt.getTime()));
        const oldestAgeHours = oldestAgeMs / (60 * 60 * 1000);

        if (!isDryRun) {
          await db
            .update(issues)
            .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
            .where(inArray(issues.id, rows.map((r) => r.issueId)));
        }

        r1Cancelled += rows.length;
        affectedRoutineIds.add(routineId);

        const { routineTitle, parentIssueId } = rows[0]!;
        await postAuditComment(parentIssueId, routineId, routineTitle, "R1", rows.length, oldestAgeHours);
      }
    }

    // ── R2: active routines with auto_gc_enabled — stale scan backlog ───────
    const activeGcRoutines = await db
      .select({
        routineId: routines.id,
        routineTitle: routines.title,
        parentIssueId: routines.parentIssueId,
        cronExpression: routineTriggers.cronExpression,
      })
      .from(routines)
      .leftJoin(routineTriggers, and(
        eq(routineTriggers.routineId, routines.id),
        eq(routineTriggers.kind, "schedule"),
        eq(routineTriggers.enabled, true),
      ))
      .where(
        and(
          eq(routines.status, "active"),
          eq(routines.autoGcEnabled, true),
        ),
      );

    for (const routine of activeGcRoutines) {
      const intervalHours = routine.cronExpression
        ? computeMinCronIntervalHours(routine.cronExpression)
        : 24;
      const r2ThresholdMs = 2 * intervalHours * 60 * 60 * 1000;
      const r2Cutoff = new Date(now.getTime() - r2ThresholdMs);

      const r2Rows = await db
        .select({ issueId: issues.id, issueCreatedAt: issues.createdAt })
        .from(issues)
        .where(
          and(
            eq(issues.originKind, "routine_execution"),
            eq(issues.originId, routine.routineId),
            eq(issues.status, "todo"),
            lt(issues.createdAt, r2Cutoff),
          ),
        )
        .limit(GC_BATCH_SIZE);

      if (r2Rows.length === 0) continue;

      const oldestAgeMs = now.getTime() - Math.min(...r2Rows.map((r) => r.issueCreatedAt.getTime()));
      const oldestAgeHours = oldestAgeMs / (60 * 60 * 1000);

      if (!isDryRun) {
        await db
          .update(issues)
          .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
          .where(inArray(issues.id, r2Rows.map((r) => r.issueId)));
      }

      r2Cancelled += r2Rows.length;
      affectedRoutineIds.add(routine.routineId);
      await postAuditComment(routine.parentIssueId, routine.routineId, routine.routineTitle, "R2", r2Rows.length, oldestAgeHours);
    }

    const total = r1Cancelled + r2Cancelled;
    if (total > 0 || isDryRun) {
      logger.info(
        { dryRun: isDryRun, r1Cancelled, r2Cancelled, affectedRoutines: affectedRoutineIds.size },
        "routine-gc: completed",
      );
    }

    return {
      dryRun: isDryRun,
      r1Cancelled,
      r2Cancelled,
      affectedRoutines: affectedRoutineIds.size,
    };
  }

  return { runGc };
}

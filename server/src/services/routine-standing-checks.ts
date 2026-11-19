import { and, asc, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, routineRuns, routineTriggers, routines } from "@paperclipai/db";
import {
  reportStandingCheckSchema,
  type ReportStandingCheck,
  type StandingCheckLastResult,
  type StandingCheckOutcome,
  type StandingCheckReported,
} from "@paperclipai/shared";
import { asBoolean, asNumber, parseObject } from "../adapters/utils.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { supportsUnscopedTimerHeartbeat } from "./heartbeat-policy.js";

/**
 * Standing checks (experimental `enableResponsibilities`): a routine whose
 * trigger is of kind `heartbeat`. The trigger never fires a run. The routine's
 * agent is told about its active standing checks each time its heartbeat
 * timer wakes it (see `loadStandingCheckGuidance`), carries each out, and
 * reports the outcome here; the outcome is kept as a routine run with source
 * `heartbeat`, so the routine's history shows every check. This module reads
 * and writes routine rows directly (it is part of the routines area) and
 * imports nothing from the heartbeat service, so the heartbeat can import it.
 */

export const STANDING_CHECK_TRIGGER_KIND = "heartbeat";
const SILENT_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval"]);

/**
 * Whether an agent wakes up on its own: an adapter that takes timer wakes
 * with no task (native runners do not), its heartbeat on with an interval,
 * and the agent taking work. A standing check only runs for such an agent.
 */
export function agentWakesOnItsOwn(agent: { adapterType: string; status: string; runtimeConfig: unknown }): boolean {
  if (SILENT_AGENT_STATUSES.has(agent.status)) return false;
  if (!supportsUnscopedTimerHeartbeat({ adapterType: agent.adapterType, runtimeConfig: parseObject(agent.runtimeConfig) })) return false;
  const heartbeat = parseObject(parseObject(agent.runtimeConfig).heartbeat);
  return asBoolean(heartbeat.enabled, false) && Math.max(0, asNumber(heartbeat.intervalSec, 0)) > 0;
}

/** One active standing check an agent carries out on each wake-up. */
export interface ActiveStandingCheck {
  routineId: string;
  triggerId: string;
  title: string;
  instructions: string | null;
  lastResult: StandingCheckLastResult | null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function standingCheckService(db: Db) {
  /**
   * The latest reported result for each routine, one query whatever the count.
   * With `issueReadCondition`, a linked task the reader cannot see is left out.
   */
  async function lastResults(
    companyId: string,
    routineIds: readonly string[],
    issueReadCondition?: SQL<boolean>,
  ): Promise<Map<string, StandingCheckLastResult>> {
    const results = new Map<string, StandingCheckLastResult>();
    if (routineIds.length === 0) return results;
    const rows = await db
      .selectDistinctOn([routineRuns.routineId], {
        routineId: routineRuns.routineId,
        triggeredAt: routineRuns.triggeredAt,
        payload: routineRuns.triggerPayload,
        issueId: issues.id,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
      })
      .from(routineRuns)
      .leftJoin(issues, and(
        eq(issues.id, routineRuns.linkedIssueId),
        eq(issues.companyId, routineRuns.companyId),
        ...(issueReadCondition ? [isNull(issues.hiddenAt), issueReadCondition] : []),
      ))
      .where(and(
        eq(routineRuns.companyId, companyId),
        inArray(routineRuns.routineId, [...new Set(routineIds)]),
        eq(routineRuns.source, STANDING_CHECK_TRIGGER_KIND),
      ))
      .orderBy(routineRuns.routineId, desc(routineRuns.triggeredAt), desc(routineRuns.id));
    for (const row of rows) {
      const payload = parseObject(row.payload);
      const outcome = payload.outcome === "acted" ? "acted" : "nothing_needed";
      results.set(row.routineId, {
        checkedAt: iso(row.triggeredAt)!,
        outcome,
        note: typeof payload.note === "string" ? payload.note : null,
        issue: row.issueId ? { id: row.issueId, identifier: row.issueIdentifier, title: row.issueTitle ?? "Task" } : null,
      });
    }
    return results;
  }

  return {
    lastResults,

    /** Which of these agents wake up on their own (see `agentWakesOnItsOwn`). */
    async wakingAgentIds(companyId: string, agentIds: readonly string[]): Promise<Set<string>> {
      if (agentIds.length === 0) return new Set();
      const rows = await db.select({
        id: agents.id,
        adapterType: agents.adapterType,
        status: agents.status,
        runtimeConfig: agents.runtimeConfig,
      }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, [...new Set(agentIds)])));
      return new Set(rows.filter(agentWakesOnItsOwn).map((row) => row.id));
    },

    /** The agent's active standing checks, by title: active routine, enabled heartbeat trigger, assigned to it. */
    async activeForAgent(companyId: string, agentId: string): Promise<ActiveStandingCheck[]> {
      const rows = await db
        .selectDistinctOn([routines.id], {
          routineId: routines.id,
          triggerId: routineTriggers.id,
          title: routines.title,
          instructions: routines.description,
        })
        .from(routines)
        .innerJoin(routineTriggers, and(
          eq(routineTriggers.routineId, routines.id),
          eq(routineTriggers.companyId, routines.companyId),
          eq(routineTriggers.kind, STANDING_CHECK_TRIGGER_KIND),
          eq(routineTriggers.enabled, true),
          eq(routineTriggers.archived, false),
        ))
        .where(and(
          eq(routines.companyId, companyId),
          eq(routines.assigneeAgentId, agentId),
          eq(routines.status, "active"),
        ))
        .orderBy(routines.id, asc(routineTriggers.createdAt));
      const last = await lastResults(companyId, rows.map((row) => row.routineId));
      return rows
        .map((row) => ({ ...row, lastResult: last.get(row.routineId) ?? null }))
        .sort((a, b) => a.title.localeCompare(b.title) || a.routineId.localeCompare(b.routineId));
    },

    /**
     * The routine's agent reports what one standing check found. Recorded as
     * a completed routine run (source `heartbeat`) linked to any task the
     * agent named; the trigger and routine remember when it last ran.
     */
    async report(
      routineRef: { id: string; companyId: string },
      input: ReportStandingCheck,
      actor: { agentId: string; runId: string | null },
    ): Promise<StandingCheckReported> {
      const data = reportStandingCheckSchema.parse(input);
      const [routine] = await db.select().from(routines)
        .where(and(eq(routines.id, routineRef.id), eq(routines.companyId, routineRef.companyId)));
      if (!routine) throw notFound("Routine not found");
      if (routine.assigneeAgentId !== actor.agentId) {
        throw forbidden("Only the agent that runs this standing check can report on it");
      }
      const [trigger] = await db.select().from(routineTriggers)
        .where(and(
          eq(routineTriggers.routineId, routine.id),
          eq(routineTriggers.companyId, routine.companyId),
          eq(routineTriggers.kind, STANDING_CHECK_TRIGGER_KIND),
          eq(routineTriggers.archived, false),
        ))
        .orderBy(asc(routineTriggers.createdAt))
        .limit(1);
      if (!trigger) {
        throw unprocessable("This routine is not a standing check", { code: "standing_check_not_standing_check" });
      }
      if (routine.status !== "active" || !trigger.enabled) {
        throw conflict("This standing check is paused or removed; there is nothing to report", { code: "standing_check_not_active" });
      }
      let issueId: string | null = null;
      if (data.issueId) {
        const [issue] = await db.select({ id: issues.id }).from(issues)
          .where(and(eq(issues.id, data.issueId), eq(issues.companyId, routine.companyId)));
        if (!issue) throw unprocessable("issueId is not a task in this organization", { code: "standing_check_unknown_issue" });
        issueId = issue.id;
      }
      const outcome: StandingCheckOutcome = data.outcome;
      const note = data.note ?? null;
      const checkedAt = new Date();
      const run = await db.transaction(async (tx) => {
        const [created] = await tx.insert(routineRuns).values({
          companyId: routine.companyId,
          routineId: routine.id,
          triggerId: trigger.id,
          source: STANDING_CHECK_TRIGGER_KIND,
          status: "completed",
          triggeredAt: checkedAt,
          completedAt: checkedAt,
          linkedIssueId: issueId,
          createdByRunId: actor.runId,
          triggerPayload: { outcome, note },
        }).returning({ id: routineRuns.id });
        await tx.update(routineTriggers)
          .set({ lastFiredAt: checkedAt, lastResult: outcome === "acted" ? `Acted: ${note}` : "Nothing needed", updatedAt: checkedAt })
          .where(eq(routineTriggers.id, trigger.id));
        await tx.update(routines)
          .set({ lastTriggeredAt: checkedAt })
          .where(eq(routines.id, routine.id));
        return created!;
      });
      return { routineId: routine.id, runId: run.id, checkedAt: checkedAt.toISOString(), outcome, note, issueId };
    },
  };
}

// ---------------------------------------------------------------------------
// What a heartbeat wake tells the agent
// ---------------------------------------------------------------------------

export interface StandingCheckGuidanceInput {
  checks: Array<Pick<ActiveStandingCheck, "routineId" | "title" | "instructions" | "lastResult">>;
}

/** Pure: the standing-check instructions for an agent's timer wake prompt. */
export function buildStandingCheckGuidance(input: StandingCheckGuidanceInput): string {
  const lines: string[] = [
    "Standing checks:",
    `You carry out ${input.checks.length === 1 ? "this standing check" : `these ${input.checks.length} standing checks`} each time your heartbeat wakes you. Do each one now, before anything else this wake-up. A standing check never creates a task by itself: create or update a task only when what you find needs work.`,
  ];
  for (const [index, check] of input.checks.entries()) {
    lines.push("", `${index + 1}. ${check.title} (routine ${check.routineId})`);
    if (check.instructions?.trim()) {
      for (const line of check.instructions.trim().split("\n")) lines.push(`   ${line}`);
    }
    if (check.lastResult) {
      const when = check.lastResult.checkedAt;
      lines.push(check.lastResult.outcome === "acted"
        ? `   Last checked ${when}: acted (${check.lastResult.note ?? "no note"}).`
        : `   Last checked ${when}: nothing needed.`);
    }
  }
  lines.push(
    "",
    "After each check, report what you found: POST /api/routines/{routineId}/standing-check-results with { outcome: \"nothing_needed\" | \"acted\", note: one plain sentence (required when you acted), issueId: the task you created or updated, if any }.",
    "Report once per check per wake-up, even when nothing was needed. 409 means the check was paused or removed: skip it. 404 means the feature is off: skip all of them. Say task, never issue, to people.",
  );
  return lines.join("\n");
}

/** The timer-wake block for an agent, or null when it has no active standing checks. The caller checks the flag. */
export async function loadStandingCheckGuidance(db: Db, input: { companyId: string; agentId: string }): Promise<string | null> {
  const checks = await standingCheckService(db).activeForAgent(input.companyId, input.agentId);
  if (checks.length === 0) return null;
  return buildStandingCheckGuidance({ checks });
}

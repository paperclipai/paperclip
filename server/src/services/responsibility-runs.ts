import { and, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues, responsibilities, routineRuns } from "@paperclipai/db";
import {
  RESPONSIBILITY_RECENT_RUNS_DEFAULT_LIMIT,
  RESPONSIBILITY_RECENT_RUNS_MAX_LIMIT,
  type ResponsibilityRecentRuns,
} from "@paperclipai/shared";
import { responsibilitiesDisabledError } from "./responsibilities-disabled.js";
import { instanceSettingsService } from "./instance-settings.js";
import { responsibilityService, type ResponsibilityReadScope } from "./responsibilities.js";

type ResponsibilityRow = typeof responsibilities.$inferSelect;

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** A requested limit, clamped; the default when absent or not a number. */
export function clampRecentRunsLimit(requested: unknown): number {
  const parsed = typeof requested === "string" ? Number.parseInt(requested, 10) : typeof requested === "number" ? requested : Number.NaN;
  if (!Number.isFinite(parsed)) return RESPONSIBILITY_RECENT_RUNS_DEFAULT_LIMIT;
  return Math.max(1, Math.min(RESPONSIBILITY_RECENT_RUNS_MAX_LIMIT, Math.trunc(parsed)));
}

/**
 * The most recent agent runs on the work under a responsibility
 * (experimental, `enableResponsibilities`), for its page: runs on its tasks
 * and on the tasks its routines created, newest first. Which tasks and
 * routines are under it is the responsibilities module's rule, read through
 * its subqueries; a run is listed only when the reader can see its task, the
 * same rule a task page's own list of runs follows. Read only: nothing about
 * a run is written here.
 */
export function responsibilityRunsService(db: Db) {
  const settings = instanceSettingsService(db);
  const responsibilitiesSvc = responsibilityService(db);

  async function assertEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableResponsibilities !== true) throw responsibilitiesDisabledError();
  }

  return {
    assertEnabled,

    async recent(row: ResponsibilityRow, scope: ResponsibilityReadScope, limit = RESPONSIBILITY_RECENT_RUNS_DEFAULT_LIMIT): Promise<ResponsibilityRecentRuns> {
      await assertEnabled();
      const member = responsibilitiesSvc.memberWorkSubqueries(row, scope);
      // Tasks its routines created, that the reader can see.
      const routineTasks = db.select({ id: routineRuns.linkedIssueId }).from(routineRuns)
        .innerJoin(issues, and(eq(issues.id, routineRuns.linkedIssueId), eq(issues.companyId, routineRuns.companyId)))
        .where(and(
          eq(routineRuns.companyId, row.companyId),
          isNotNull(routineRuns.linkedIssueId),
          inArray(routineRuns.routineId, member.routineIds),
          isNull(issues.hiddenAt),
          scope.issueReadCondition,
        ));
      const rows = await db.select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        createdAt: heartbeatRuns.createdAt,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        issueId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
      }).from(heartbeatRuns)
        .innerJoin(issues, and(eq(issues.id, heartbeatRuns.issueId), eq(issues.companyId, heartbeatRuns.companyId)))
        .where(and(
          eq(heartbeatRuns.companyId, row.companyId),
          or(inArray(heartbeatRuns.issueId, member.issueIds), inArray(heartbeatRuns.issueId, routineTasks)),
        ))
        .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
        .limit(limit);
      // Which routine a run's task came from, when it came from one under this responsibility.
      const routineOf = new Map<string, string>();
      const issueIds = [...new Set(rows.map((run) => run.issueId))];
      if (issueIds.length > 0) {
        const links = await db.select({ issueId: routineRuns.linkedIssueId, routineId: routineRuns.routineId }).from(routineRuns)
          .where(and(
            eq(routineRuns.companyId, row.companyId),
            inArray(routineRuns.linkedIssueId, issueIds),
            inArray(routineRuns.routineId, member.routineIds),
          ));
        for (const link of links) if (link.issueId) routineOf.set(link.issueId, link.routineId);
      }
      return {
        responsibilityId: row.id,
        runs: rows.map((run) => ({
          id: run.id,
          agentId: run.agentId,
          status: run.status,
          createdAt: iso(run.createdAt)!,
          startedAt: iso(run.startedAt),
          finishedAt: iso(run.finishedAt),
          issue: { id: run.issueId, identifier: run.identifier, title: run.title },
          routineId: routineOf.get(run.issueId) ?? null,
        })),
        limit,
      };
    },
  };
}

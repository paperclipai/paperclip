import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, issueWatchdogs } from "@paperclipai/db";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { budgetService } from "./budgets.js";
import { isHeartbeatWakeOnDemandEnabled } from "./heartbeat-policy.js";
import { taskWatchdogService, type TaskWatchdogClassifierResult } from "./task-watchdogs.js";

// Stop-state verdicts after which the watchdog still owns the next wake:
// `stopped` fires now (or an open review for this stop state already owns
// it), and `live` / `pending_first_run` re-evaluate once the subtree goes
// idle. `already_reviewed` never fires again for the same stop state, and
// `not_applicable` never fires at all.
const WATCHDOG_OWNED_STOP_STATES = new Set<TaskWatchdogClassifierResult["state"]>([
  "stopped",
  "live",
  "pending_first_run",
]);

/**
 * True when the issue itself has an active watchdog that can actually
 * deliver the next wake. Such a watchdog is a deliberate, supervised wait: it
 * owns the next wake for an idle issue, so recovery must not re-wake the
 * issue first.
 *
 * The check follows the watchdog delivery path, so a watchdog does not count
 * when:
 * - its agent is missing, in another company, or not invokable (paused,
 *   terminated, pending approval, invalid reporting chain);
 * - its agent has on-demand wakes disabled (watchdog wakes are automation
 *   wakes, which that policy skips);
 * - a budget hard-stop blocks its agent (company, agent, or project scope);
 * - it already reviewed the current stop state of the watched subtree, so it
 *   will not fire again until that state changes.
 *
 * Only the issue's own watchdog counts; a watchdog on an ancestor issue is
 * not considered here.
 */
export async function hasArmedInvokableIssueWatchdog(
  db: Db,
  issue: { id: string; companyId: string },
) {
  const row = await db
    .select({
      watchdog: issueWatchdogs,
      agent: {
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        reportsTo: agents.reportsTo,
        status: agents.status,
        runtimeConfig: agents.runtimeConfig,
      },
      projectId: issues.projectId,
    })
    .from(issueWatchdogs)
    .innerJoin(
      agents,
      and(
        eq(agents.id, issueWatchdogs.watchdogAgentId),
        eq(agents.companyId, issueWatchdogs.companyId),
      ),
    )
    .innerJoin(
      issues,
      and(
        eq(issues.id, issueWatchdogs.issueId),
        eq(issues.companyId, issueWatchdogs.companyId),
      ),
    )
    .where(
      and(
        eq(issueWatchdogs.companyId, issue.companyId),
        eq(issueWatchdogs.issueId, issue.id),
        eq(issueWatchdogs.status, "active"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return false;
  const { watchdog, agent, projectId } = row;

  if (!(await evaluateAgentInvokabilityFromDb(db, agent)).invokable) return false;
  if (!isHeartbeatWakeOnDemandEnabled(agent)) return false;

  // The watchdog wake runs on the watchdog issue, which shares the watched
  // issue's project; enqueueWakeup applies this same block to it.
  const budgetBlock = await budgetService(db).getInvocationBlock(issue.companyId, agent.id, {
    issueId: watchdog.watchdogIssueId ?? issue.id,
    projectId,
  });
  if (budgetBlock) return false;

  const stopState = await taskWatchdogService(db).previewWatchdogStopState(watchdog);
  return WATCHDOG_OWNED_STOP_STATES.has(stopState.state);
}

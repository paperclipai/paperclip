import type { FlatIssueMonitorStatus } from "./issue-execution-policy.js";

/**
 * The 4-condition "no wake path" definition from AGE-924, layered on top of
 * (and independent from) AGE-570's `lastActivityAt`/`staleHours` proxy.
 * `lastActivityAt` measures recency; this measures whether *anything* will
 * ever cause the issue to be looked at again. An issue can be touched 5
 * minutes ago and still have no wake path (e.g. `in_review` with a cleared
 * monitor); conversely an issue untouched for 100h with a monitor 2 days out
 * is healthy. Only this classifier, not staleHours, should gate an "is this
 * issue dead" decision.
 */
export type NoWakePathReason =
  | "blocked_no_blockers_no_monitor"
  | "in_review_spent_monitor_no_blocker"
  | "todo_unassigned"
  | "assignee_saturated";

export interface NoWakePathIssueInput {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  /** Unresolved (not done/cancelled) blocker issue ids for this issue. */
  blockedByIssueIds: readonly string[];
  /** Flat-column-derived monitor projection; see `deriveFlatMonitorStatus`. */
  monitorStatus: FlatIssueMonitorStatus | null;
  /** True if an active run currently owns this specific issue. */
  hasActiveRun: boolean;
  /** Current status of `assigneeAgentId`'s agent record, if any. */
  assigneeAgentStatus: string | null;
}

/**
 * Classify why an issue has no live wake path, or return `null` if it has
 * one (or its status makes the question moot, e.g. `done`/`cancelled`).
 *
 * Conditions (verbatim from AGE-924, evaluated independently — any one match
 * is sufficient):
 * 1. `blocked` + empty `blockedByIssueIds` + no monitor.
 * 2. `in_review` + `monitorStatus` in `{none, triggered}` (both `cleared` and
 *    `triggered` collapse to "not scheduled" in the flat projection — see
 *    `deriveFlatMonitorStatus`) + no unresolved blocker.
 * 3. `todo` + no assignee (agent or user).
 * 4. An agent assignee is set, that agent's own status is `running`, but no
 *    active run is bound to *this* issue — the assignee is saturated on a
 *    different lane and cannot wake this one.
 */
export function classifyNoWakePath(issue: NoWakePathIssueInput): NoWakePathReason | null {
  if (
    issue.status === "blocked" &&
    issue.blockedByIssueIds.length === 0 &&
    issue.monitorStatus !== "scheduled"
  ) {
    return "blocked_no_blockers_no_monitor";
  }

  if (
    issue.status === "in_review" &&
    (issue.monitorStatus === "none" || issue.monitorStatus === "triggered") &&
    issue.blockedByIssueIds.length === 0
  ) {
    return "in_review_spent_monitor_no_blocker";
  }

  if (issue.status === "todo" && !issue.assigneeAgentId && !issue.assigneeUserId) {
    return "todo_unassigned";
  }

  if (
    issue.assigneeAgentId &&
    issue.assigneeAgentStatus === "running" &&
    !issue.hasActiveRun
  ) {
    return "assignee_saturated";
  }

  return null;
}

export function isNoWakePath(issue: NoWakePathIssueInput): boolean {
  return classifyNoWakePath(issue) !== null;
}

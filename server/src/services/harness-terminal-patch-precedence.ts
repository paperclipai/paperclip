// Feature flag and helpers for the harness terminal-PATCH precedence and
// assignee-comment continuation filter. Tracked under MONAA-558 (origin
// MONAA-556). Both mitigations live behind a single env flag.
//
// 1. Recovery skip: when the latest comment on an active assigned issue was
//    authored by the assignee themselves, the recovery sweep does not retrigger
//    a `stranded_assigned_issue` / `issue_continuation_needed` continuation
//    based on that comment alone.
// 2. Terminal-PATCH precedence: when a PATCH /api/issues body transitions the
//    status to a terminal value (done/cancelled), comment-driven wakeups for
//    that same body are suppressed so the terminal transition is not preempted.
//
// MONAA-674: default flipped to on after the 24h observation window in
// MONAA-558 closed with a 100% reduction in continuation-cascade restarts
// (~80/h baseline -> 0/24h post-deploy). Opt out by setting the env var to
// "false".

import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments } from "@paperclipai/db";

const FLAG_ENV_VAR = "HARNESS_TERMINAL_PATCH_PRECEDENCE";

export function isHarnessTerminalPatchPrecedenceEnabled(): boolean {
  return process.env[FLAG_ENV_VAR] !== "false";
}

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

export function isTerminalIssueStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && TERMINAL_STATUSES.has(status);
}

export function didStatusBecomeTerminal(
  previousStatus: string | null | undefined,
  nextStatus: string | null | undefined,
): boolean {
  return !isTerminalIssueStatus(previousStatus) && isTerminalIssueStatus(nextStatus);
}

export async function isLatestIssueCommentByAssignee(
  db: Db,
  issueId: string,
  assigneeAgentId: string | null | undefined,
): Promise<boolean> {
  if (!assigneeAgentId) return false;
  const latest = await db
    .select({ authorAgentId: issueComments.authorAgentId })
    .from(issueComments)
    .where(eq(issueComments.issueId, issueId))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!latest) return false;
  return latest.authorAgentId === assigneeAgentId;
}

import type { Db } from "@paperclipai/db";
import type { ExecutionWorkspacePullRequestRecord } from "@paperclipai/shared";

/**
 * Notifies the timeout scheduler that a blocking-mode PR request was
 * just recorded. In this commit the function is a no-op stub; the
 * follow-up commit in this branch wires it to a real timeout
 * scheduler that emits `execution_workspace.pull_request_timed_out`
 * and transitions the workspace to `archived` when the record's
 * `archiveTimeoutMs` deadline passes.
 *
 * Kept as a stub here so the routes (which import it) compile cleanly
 * in the review window between the routes commit and the scheduler
 * commit. Callers should pass the workspace id, the record, and the
 * Db handle so the eventual implementation can do its row-lock race
 * checks.
 */
export function onPullRequestRequested(_input: {
  db: Db;
  companyId: string;
  workspaceId: string;
  record: ExecutionWorkspacePullRequestRecord;
}): void {
  // Replaced in a follow-up commit on this branch.
}

/**
 * Boot-time re-scan hook. In this commit the function is a no-op; the
 * follow-up commit implements the DB re-scan that restores timers for
 * blocking-mode records that were in flight when the server last
 * shut down.
 */
export async function rescheduleBlockingPullRequestTimeouts(_db: Db): Promise<{ rescheduled: number }> {
  return { rescheduled: 0 };
}

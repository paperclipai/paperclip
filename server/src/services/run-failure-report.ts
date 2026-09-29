import { eq } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { captureRunFailure, type RunFailureStatus } from "../sentry.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { redactSensitiveText } from "../redaction.js";
import { logger } from "../middleware/logger.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

const UNKNOWN_ADAPTER = "unknown";

/** Sentry rejects an oversized event with HTTP 413. Bound the error message. */
const MAX_ERROR_MESSAGE_LENGTH = 4096;
/** The error code is a short label. Bound it well under the message limit. */
const MAX_ERROR_CODE_LENGTH = 200;

/**
 * Every report that `reportRunFailure` started and has not yet settled.
 * Shutdown must wait for this set to drain — see `waitForPendingRunFailureReports`.
 */
const pendingRunFailureReports = new Set<Promise<void>>();

/** Bounds the shutdown wait, so one stuck report cannot hang the process exit. */
const PENDING_REPORT_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Remove a credential and the current user's home path from adapter-supplied
 * text, then cut the result to `maxLength`. Run the length cut after the
 * redaction, so a credential cannot survive at a cut boundary.
 */
function sanitizeAdapterText(input: string, maxLength: number): string {
  return redactSensitiveText(redactCurrentUserText(input)).slice(0, maxLength);
}

function isRunFailureStatus(status: string): status is RunFailureStatus {
  return status === "failed" || status === "timed_out";
}

function readTaskId(run: HeartbeatRun): string | null {
  if (run.nativeIssueId) return run.nativeIssueId;
  const contextIssueId = run.contextSnapshot?.issueId;
  return typeof contextIssueId === "string" && contextIssueId.length > 0 ? contextIssueId : null;
}

/**
 * Report a terminal run failure to Sentry. Returns at once for any status
 * other than `failed` and `timed_out`. Never throws — a Sentry failure or a
 * database read failure must not change the caller's control flow.
 *
 * Call this beside the caller's own terminal-status write, with
 * `void reportRunFailure(db, run)`. Do not await it — a Sentry read must
 * not delay the caller's own required lifecycle work. The function tracks
 * its own in-flight promise, so a caller that does not await it still lets
 * shutdown find and wait for the report — see `waitForPendingRunFailureReports`.
 */
export function reportRunFailure(db: Db, run: HeartbeatRun): Promise<void> {
  if (!isRunFailureStatus(run.status)) return Promise.resolve();
  const runStatus = run.status;
  const report = captureTerminalRunFailure(db, run, runStatus);
  pendingRunFailureReports.add(report);
  void report.finally(() => pendingRunFailureReports.delete(report));
  return report;
}

async function captureTerminalRunFailure(
  db: Db,
  run: HeartbeatRun,
  runStatus: RunFailureStatus,
): Promise<void> {
  try {
    const agent = await db
      .select({ adapterType: agents.adapterType })
      .from(agents)
      .where(eq(agents.id, run.agentId))
      .then((rows) => rows[0] ?? null);

    const taskId = readTaskId(run);
    if (!taskId) {
      logger.warn({ runId: run.id }, "run failure report has no task id, skipping Sentry report");
      return;
    }

    captureRunFailure({
      taskId,
      runId: run.id,
      errorMessage: sanitizeAdapterText(run.error ?? "", MAX_ERROR_MESSAGE_LENGTH),
      errorCode:
        run.errorCode === null
          ? null
          : sanitizeAdapterText(run.errorCode, MAX_ERROR_CODE_LENGTH),
      agentAdapter: agent?.adapterType ?? UNKNOWN_ADAPTER,
      runStatus,
    });
  } catch (err) {
    logger.warn({ err, runId: run.id }, "failed to report run failure to Sentry");
  }
}

/**
 * Wait for every run-failure report that is still in flight, up to
 * `timeoutMs`. Call this during server shutdown, before the database pool
 * ends and before Sentry flushes — `reportRunFailure` reads the database and
 * then calls Sentry, so a report started just before shutdown can otherwise
 * lose its database read, its Sentry call, or both. Never throws.
 */
export async function waitForPendingRunFailureReports(
  timeoutMs = PENDING_REPORT_DRAIN_TIMEOUT_MS,
): Promise<void> {
  if (pendingRunFailureReports.size === 0) return;
  const drained = Promise.allSettled(Array.from(pendingRunFailureReports));
  await Promise.race([
    drained,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
}

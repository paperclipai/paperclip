import { and, eq } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { captureRunFailure, type RunFailureStatus } from "../sentry.js";
import {
  collectRunFailureDiagnostics,
  collectRunFailureSecretValues,
  redactRunFailureSecretValues,
  sanitizeRunFailureDiagnostics,
  sanitizeRunFailureText,
  type RunFailureReportOptions,
} from "./run-failure-diagnostics.js";
import { logger } from "../middleware/logger.js";
import { isUnexpectedRunCancellation } from "./run-cancellation.js";

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

function isRunFailureStatus(status: string): status is RunFailureStatus {
  return status === "failed" || status === "timed_out" || status === "cancelled";
}

function readTaskId(run: HeartbeatRun): string | null {
  if (run.nativeIssueId) return run.nativeIssueId;
  const contextIssueId = run.contextSnapshot?.issueId;
  return typeof contextIssueId === "string" && contextIssueId.length > 0 ? contextIssueId : null;
}

/**
 * Report a terminal run failure to Sentry. Returns at once for any status
 * other than failures and unexpected started cancellations. Never throws — a Sentry failure or a
 * database read failure must not change the caller's control flow.
 *
 * Call this beside the caller's own terminal-status write, with
 * `void reportRunFailure(db, run)`. Do not await it — a Sentry read must
 * not delay the caller's own required lifecycle work. The function tracks
 * its own in-flight promise, so a caller that does not await it still lets
 * shutdown find and wait for the report — see `waitForPendingRunFailureReports`.
 */
export function reportRunFailure(db: Db, run: HeartbeatRun, options: RunFailureReportOptions = {}): Promise<void> {
  if (!isRunFailureStatus(run.status)) return Promise.resolve();
  if (run.status === "cancelled" && !isUnexpectedRunCancellation(run)) return Promise.resolve();
  const runStatus = run.status;
  const report = captureTerminalRunFailure(db, run, runStatus, options);
  pendingRunFailureReports.add(report);
  void report.finally(() => pendingRunFailureReports.delete(report));
  return report;
}

async function captureTerminalRunFailure(
  db: Db,
  run: HeartbeatRun,
  runStatus: RunFailureStatus,
  options: RunFailureReportOptions,
): Promise<void> {
  try {
    const snapshot = redactRunFailureSecretValues({
      errorMessage: run.error ?? "",
      errorCode: run.errorCode ?? null,
      diagnostics: collectRunFailureDiagnostics(run, options),
    }, [...new Set([
      ...collectRunFailureSecretValues(process.env, [], true),
      ...(options.secretValues ?? []),
    ])].sort((a, b) => b.length - a.length));
    const agent = await db
      .select({ adapterType: agents.adapterType })
      .from(agents)
      .where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)))
      .then((rows) => rows[0] ?? null);

    const taskId = readTaskId(run);
    if (!taskId) {
      logger.warn({ runId: run.id }, "run failure report has no task id, skipping Sentry report");
      return;
    }

    // Resolve registered values before truncation. A failed resolution must
    // not send an incompletely redacted report.
    let redacted = snapshot;
    if (Array.isArray(run.contextSnapshot?.paperclipSecretRedactions)) {
      const { createRunSecretRedactionRegistry } = await import("./run-secret-redaction.js");
      redacted = await createRunSecretRedactionRegistry(db).redactForRun(run.companyId, run.id, snapshot);
    }
    captureRunFailure({
      taskId,
      runId: run.id,
      errorMessage: sanitizeRunFailureText(redacted.errorMessage, MAX_ERROR_MESSAGE_LENGTH),
      errorCode:
        redacted.errorCode === null
          ? null
          : sanitizeRunFailureText(redacted.errorCode, MAX_ERROR_CODE_LENGTH),
      agentAdapter: agent?.adapterType ?? UNKNOWN_ADAPTER,
      runStatus,
      exitCode: run.exitCode,
      signal: run.signal,
      diagnostics: sanitizeRunFailureDiagnostics(redacted.diagnostics),
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

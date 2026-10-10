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
import { readConnectionFailure, type ConnectionFailure } from "@paperclipai/adapter-utils/connection-failure";
import { isAiConnectionConfigurationReason } from "./ai-connection-configuration-failure.js";

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** An owned AI selection rejection before dispatch, not its broad catch wrapper. */
function isAiConnectionSelectionBlocker(run: HeartbeatRun, options: RunFailureReportOptions): boolean {
  // Resumed native input may already have provider effects, even during preparation.
  if (run.runtimeMode === "native" && asRecord(run.runnerProfileJson)?.nativeExecutionInput !== undefined) return false;
  if (
    run.status !== "failed" || run.errorCode !== "configuration_incomplete" ||
    run.executionStage !== "preparing" || options.phase !== "setup" ||
    run.exitCode != null || run.signal != null
  ) return false;
  const configuration = asRecord(run.resultJson?.configurationIncomplete);
  const recovery = asRecord(run.resultJson?.executionRecovery);
  return configuration?.reason === "ai_connection_unavailable" &&
    isAiConnectionConfigurationReason(configuration.selectionFailure) &&
    recovery?.kind === "bootstrap" && recovery.providerWorkStarted === false;
}

/** A known owner action before dispatch, not a secret-provider or runtime failure. */
function isMissingSecretConfigurationBlocker(run: HeartbeatRun, options: RunFailureReportOptions): boolean {
  if (
    run.status !== "failed" ||
    run.errorCode !== "configuration_incomplete" ||
    run.executionStage !== "preparing" ||
    options.phase !== "setup" ||
    run.exitCode != null ||
    run.signal != null
  ) return false;

  const configuration = asRecord(run.resultJson?.configurationIncomplete);
  const recovery = asRecord(run.resultJson?.executionRecovery);
  if (
    configuration?.reason !== "secret_binding_missing" ||
    recovery?.kind !== "bootstrap" ||
    recovery.providerWorkStarted !== false ||
    !Array.isArray(configuration.missingBindings) ||
    configuration.missingBindings.length === 0
  ) return false;

  return configuration.missingBindings.every((value: unknown) => {
    const binding = asRecord(value);
    if (!binding) return false;
    if (binding.bindingType === "secret_ref") {
      return binding.errorCode == null || binding.errorCode === "binding_missing";
    }
    if (binding.bindingType !== "user_secret_ref") return false;
    // Missing-definition resolution can also catch a database error. Keep that
    // ambiguous case, unknown codes, and provider errors visible in Sentry.
    return binding.errorCode === "binding_missing" ||
      binding.errorCode === "responsible_user_missing" ||
      binding.errorCode === "user_secret_missing" ||
      binding.errorCode === "secret_inactive" ||
      binding.errorCode === "user_secret_definition_inactive";
  });
}

/** The workspace resolver proved an explicit local-path/worktree policy mismatch. */
function isLocalPathWorkspaceConfigurationBlocker(run: HeartbeatRun, options: RunFailureReportOptions): boolean {
  if (
    run.status !== "failed" || run.errorCode !== "workspace_validation_failed" ||
    run.executionStage !== "preparing" || options.phase !== "setup" ||
    run.exitCode != null || run.signal != null
  ) return false;

  const validation = asRecord(run.resultJson?.workspaceValidation);
  const recovery = asRecord(run.resultJson?.executionRecovery);
  return validation?.reason === "git_worktree_base_not_git_checkout" &&
    validation.configurationReason === "local_path_requires_git_checkout" &&
    validation.resolvedWorkspaceSource === "project_primary" &&
    validation.workspaceStrategyType === "git_worktree" &&
    (validation.requestedExecutionWorkspaceMode === "isolated_workspace" ||
      validation.requestedExecutionWorkspaceMode === "operator_branch") &&
    recovery?.kind === "bootstrap" && recovery.providerWorkStarted === false;
}

/** Only the managed-clone producer can attach this bounded pre-dispatch evidence. */
function isGitConnectionFailure(run: HeartbeatRun, options: RunFailureReportOptions): boolean {
  const connection = readConnectionFailure(run.resultJson?.connectionFailure);
  if (connection?.provider !== "git" || run.status !== "failed" || run.executionStage !== "preparing" ||
      options.phase !== "setup" || run.exitCode != null || run.signal != null) return false;
  const recovery = asRecord(run.resultJson?.executionRecovery);
  if (recovery?.kind !== "bootstrap" || recovery.providerWorkStarted !== false) return false;
  const validation = asRecord(run.resultJson?.workspaceValidation);
  if (run.errorCode === "setup_failed") return !validation;
  if (run.errorCode !== "workspace_validation_failed" || validation?.reason !== "git_worktree_base_materialization_failed") return false;
  const failures = validation.materializationFailures;
  return Array.isArray(failures) && failures.length > 0 && failures.every((failure) => {
    const marker = readConnectionFailure(asRecord(failure)?.connectionFailure);
    return marker?.provider === "git";
  }) && readConnectionFailure(asRecord(failures[0])?.connectionFailure)?.reason === connection.reason;
}

const hermesTransportReasons = new Set([
  "connection_refused", "dns_failure", "network_unreachable", "connection_reset", "connection_timeout", "tls_failure",
]);

/** An adapter result remains failed; this only excludes its proven external cause. */
function isHermesConnectionFailure(run: HeartbeatRun, options: RunFailureReportOptions, adapterType: string | undefined): boolean {
  if (adapterType !== "hermes_gateway" || run.status !== "failed" || run.exitCode !== 1 || run.signal != null || options.phase === "setup") return false;
  const connection = readConnectionFailure(run.resultJson?.connectionFailure);
  if (connection?.provider !== "hermes_gateway") return false;
  const code = run.errorCode;
  if (connection.operation === "configuration") {
    const codes: Record<Extract<ConnectionFailure, { provider: "hermes_gateway"; operation: "configuration" }>["reason"], string> = {
      endpoint_missing: "hermes_gateway_api_base_url_missing",
      endpoint_invalid: "hermes_gateway_api_base_url_invalid",
      insecure_transport: "hermes_gateway_plain_http_remote_denied",
      credentials_missing: "hermes_gateway_api_key_missing",
    };
    return code === codes[connection.reason];
  }
  if (hermesTransportReasons.has(connection.reason)) return code === "hermes_gateway_connect_failed" || code === "hermes_gateway_protocol_error";
  return (connection.reason === "authentication_failed" && code === "hermes_gateway_auth_failed") ||
    (connection.reason === "endpoint_not_found" && code === "hermes_gateway_runs_unsupported") ||
    (connection.reason === "rate_limited" && code === "hermes_gateway_rate_limited") ||
    (connection.reason === "remote_unavailable" && code === "hermes_gateway_upstream_error");
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
  if (isMissingSecretConfigurationBlocker(run, options)) return Promise.resolve();
  if (isAiConnectionSelectionBlocker(run, options)) return Promise.resolve();
  if (isLocalPathWorkspaceConfigurationBlocker(run, options)) return Promise.resolve();
  if (isGitConnectionFailure(run, options)) return Promise.resolve();
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

    if (isHermesConnectionFailure(run, options, agent?.adapterType)) return;

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

import { and, eq } from "drizzle-orm";
import { agents, dotRunnerAssignments, grokBotDispatches, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
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
import { readRunFailureReportingMode, type RunFailureReportingMode } from "../sentry-run-failure-policy.js";
import { RESTRICTED_WORKSPACE_SOURCE_REASON } from "./workspace-source-restriction.js";

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

type RunFailureTransitionState = Pick<HeartbeatRun, "status" | "runtimeMode" | "nativePhase">;

/**
 * A native run that waits for a same-run retry is stored as `failed` with
 * `nativePhase: "retryable_failure"`. That is not terminal: the retry or the
 * workspace copy-back retry can still finish the run as succeeded.
 */
function isPendingNativeRetry(run: RunFailureTransitionState): boolean {
  return run.status === "failed" && run.runtimeMode === "native" && run.nativePhase === "retryable_failure";
}

/**
 * Whether a status write is a new terminal failure to pass to `reportRunFailure`.
 * A status change counts. A run that leaves a pending native retry but stays
 * `failed` also counts, because `reportRunFailure` skipped its earlier write.
 */
export function isNewTerminalRunFailure(before: RunFailureTransitionState, after: RunFailureTransitionState): boolean {
  if (after.status !== before.status) return true;
  return isPendingNativeRetry(before) && !isPendingNativeRetry(after);
}

function readTaskId(run: HeartbeatRun): string | null {
  if (run.issueId) return run.issueId;
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

/** A retained shared checkout denied by task privacy before dispatch; the task notice names the owner action. */
function isRestrictedWorkspaceSourceBlocker(run: HeartbeatRun, options: RunFailureReportOptions): boolean {
  if (
    run.status !== "failed" || run.errorCode !== "configuration_incomplete" ||
    run.executionStage !== "preparing" || options.phase !== "setup" ||
    run.exitCode != null || run.signal != null
  ) return false;
  const configuration = asRecord(run.resultJson?.configurationIncomplete);
  const recovery = asRecord(run.resultJson?.executionRecovery);
  return configuration?.reason === RESTRICTED_WORKSPACE_SOURCE_REASON &&
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
 * The orphan reaper proved a server restart stopped legacy setup before
 * dispatch and made the run eligible for its bounded retry. Only that reaper
 * branch pairs process loss with bootstrap evidence.
 */
function isRestartInterruptedSetup(run: HeartbeatRun): boolean {
  if (
    run.status !== "failed" || run.errorCode !== "process_lost" || run.runtimeMode !== "legacy" ||
    run.executionStage !== "preparing" || run.processPid != null || run.processGroupId != null
  ) return false;
  const recovery = asRecord(run.resultJson?.executionRecovery);
  const processLoss = asRecord(run.resultJson?.processLossDiagnostic);
  return recovery?.kind === "bootstrap" && recovery.providerWorkStarted === false &&
    processLoss?.retryEligible === true && processLoss.runPredatesObserver === true &&
    processLoss.localCheck === "no_identifiers";
}

/**
 * The adapter proved the user's provider account is out of quota, and recovery
 * waits for its reset. Both fields come from the adapter's own classifier.
 */
function isProviderQuotaFailure(run: HeartbeatRun, options: RunFailureReportOptions): boolean {
  return run.status === "failed" && run.errorCode === "provider_quota" &&
    asRecord(run.resultJson)?.errorFamily === "provider_quota" &&
    options.phase !== "setup" && run.signal == null;
}

function isCodexAcpModelCapacityFailure(run: HeartbeatRun, options: RunFailureReportOptions): boolean {
  const result = asRecord(run.resultJson);
  return run.status === "failed" && run.errorCode === "codex_transient_upstream" &&
    result?.errorFamily === "transient_upstream" &&
    asRecord(result.terminalSessionFailure)?.category === "service" &&
    options.phase !== "setup" && run.signal == null;
}

const providerAuthErrorCodes = new Set(["claude_auth_required", "acpx_auth_required"]);

/**
 * The ACP agent typed its terminal failure as `access` (provider auth_required),
 * and the adapter kept it on the sign-in recovery path. The run blocks and the
 * user gets a reconnect request, so Sentry adds no signal.
 */
function isAcpProviderAccessFailure(run: HeartbeatRun, options: RunFailureReportOptions): boolean {
  return run.status === "failed" && run.errorCode != null && providerAuthErrorCodes.has(run.errorCode) &&
    asRecord(asRecord(run.resultJson)?.terminalSessionFailure)?.category === "access" &&
    options.phase !== "setup" && run.signal == null;
}

/**
 * The Grok endpoint refused every work wake with an HTTP 4xx, so the offer
 * expired unaccepted. Durable delivery receipts prove the external cause. A
 * local rejection (no HTTP status), any delivered wake, or accepted work stays
 * reportable.
 */
async function isRejectedExternalBotWake(db: Db, run: HeartbeatRun): Promise<boolean> {
  if (run.status !== "failed" || run.runtimeMode !== "native" || run.errorCode !== "native_provider_terminal_failed") return false;
  const [finalization] = await db.select({ failureDetail: nativeRunFinalizations.failureDetail }).from(nativeRunFinalizations)
    .where(and(eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId)));
  if (finalization?.failureDetail?.originalFailureCode !== "dot_assignment_expired") return false;
  const offers = await db.select({ id: dotRunnerAssignments.id, acceptedAt: dotRunnerAssignments.acceptedAt }).from(dotRunnerAssignments)
    .where(and(eq(dotRunnerAssignments.runId, run.id), eq(dotRunnerAssignments.companyId, run.companyId)));
  if (offers.length !== 1 || offers[0]!.acceptedAt) return false;
  const wakes = await db.select({ status: grokBotDispatches.status, httpStatus: grokBotDispatches.httpStatus }).from(grokBotDispatches)
    .where(and(eq(grokBotDispatches.assignmentId, offers[0]!.id), eq(grokBotDispatches.companyId, run.companyId),
      eq(grokBotDispatches.kind, "mailbox_updated")));
  return wakes.length > 0 && wakes.every((wake) =>
    wake.status === "rejected" && wake.httpStatus != null && wake.httpStatus >= 400 && wake.httpStatus < 500);
}

/**
 * Report a terminal run failure to Sentry. Returns at once for any status
 * other than failures and unexpected started cancellations, and for a native
 * run that still waits for a same-run retry. Never throws — a Sentry failure or a
 * database read failure must not change the caller's control flow.
 *
 * Call this beside the caller's own terminal-status write, with
 * `void reportRunFailure(db, run)`. Do not await it — a Sentry read must
 * not delay the caller's own required lifecycle work. The function tracks
 * its own in-flight promise, so a caller that does not await it still lets
 * shutdown find and wait for the report — see `waitForPendingRunFailureReports`.
 */
export function reportRunFailure(db: Db, run: HeartbeatRun, options: RunFailureReportOptions = {}): Promise<void> {
  const mode = readRunFailureReportingMode();
  if (mode === "off") return Promise.resolve();
  if (!isRunFailureStatus(run.status)) return Promise.resolve();
  if (run.status === "cancelled" && !isUnexpectedRunCancellation(run)) return Promise.resolve();
  // The terminal write that ends the retry reports instead (`isNewTerminalRunFailure`).
  if (isPendingNativeRetry(run)) return Promise.resolve();
  if (mode === "unexpected" && (
    isMissingSecretConfigurationBlocker(run, options) ||
    isAiConnectionSelectionBlocker(run, options) ||
    isLocalPathWorkspaceConfigurationBlocker(run, options) ||
    isRestrictedWorkspaceSourceBlocker(run, options) ||
    isGitConnectionFailure(run, options) ||
    isProviderQuotaFailure(run, options) ||
    isCodexAcpModelCapacityFailure(run, options) ||
    isAcpProviderAccessFailure(run, options) ||
    isRestartInterruptedSetup(run)
  )) return Promise.resolve();
  const runStatus = run.status;
  const report = captureTerminalRunFailure(db, run, runStatus, options, mode);
  pendingRunFailureReports.add(report);
  void report.finally(() => pendingRunFailureReports.delete(report));
  return report;
}

async function captureTerminalRunFailure(
  db: Db,
  run: HeartbeatRun,
  runStatus: RunFailureStatus,
  options: RunFailureReportOptions,
  mode: RunFailureReportingMode,
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

    if (mode === "unexpected") {
      if (isHermesConnectionFailure(run, options, agent?.adapterType)) return;
      const rejectedExternally = await isRejectedExternalBotWake(db, run).catch((err) => {
        logger.warn({ err, runId: run.id }, "failed to read bot wake receipts for run failure report");
        return false;
      });
      if (rejectedExternally) return;
    }

    const taskId = readTaskId(run);

    // Resolve registered values before truncation. A failed resolution must
    // not send an incompletely redacted report.
    let redacted = snapshot;
    if (Array.isArray(run.contextSnapshot?.paperclipSecretRedactions)) {
      const { createRunSecretRedactionRegistry } = await import("./run-secret-redaction.js");
      redacted = await createRunSecretRedactionRegistry(db).redactForRun(run.companyId, run.id, snapshot);
    }
    captureRunFailure({
      companyId: run.companyId,
      agentId: run.agentId,
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

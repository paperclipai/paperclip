import { readWorkspaceBaseRefDiagnostic } from "./workspace-base-ref-diagnostics.js";
import { getEnvironmentAcquisitionDiagnostic } from "./environment-acquisition-diagnostics.js";
import type { heartbeatRuns } from "@paperclipai/db";
import { readControllerLeaseLoss, readControllerLeaseLossCause, readRunCancellation } from "./run-cancellation.js";
import { readProcessLossDiagnostic } from "./process-loss-diagnostics.js";
import { readReviewedChatBindingDenialReason } from "./reviewed-chat-binding-diagnostics.js";
import { WORKSPACE_RESTORE_FAILURE_CODES } from "@paperclipai/shared";
import { collectDiagnosticEnvironmentSecrets, redactDiagnosticText } from "@paperclipai/adapter-utils/command-redaction";
import { directoryMergeLockTimeoutDiagnosticsFor } from "@paperclipai/adapter-utils/directory-merge-lock-diagnostics";
import { sanitizeWorkspaceRestoreDiagnostic } from "@paperclipai/adapter-utils/workspace-restore-diagnostics";
import {
  ACP_PROCESS_TERMINAL_SIGNALS,
  ACP_PROCESS_TERMINAL_SOURCES,
  ACP_TOOL_KINDS,
} from "@paperclipai/adapter-utils/acpx-engine/constants";
import { redactCurrentUserText } from "../log-redaction.js";
import { storageFailureDiagnosticsFor } from "../storage/failure-diagnostics.js";
import { redactSensitiveText, REDACTED_EVENT_VALUE } from "../redaction.js";
import { readNativeModelRejectionDiagnostic, readNativeTurnFailureDiagnostic } from "./native-runtime/native-provider-failure.js";
import { readRemoteRunnerRecoveryDiagnostic, readRemoteRunnerRecoveryError } from "./native-runtime/remote-runner-recovery-diagnostics.js";
import { MANAGED_GIT_WORKTREE_REASON_CODES, PERSISTED_WORKSPACE_SOURCE_REASON_CODES, readManagedGitInspectionDiagnostic } from "./workspace-validation-diagnostics.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Context = Record<string, string | number | boolean>;

export interface RunFailureReportOptions {
  /** The caught exception, before callers flatten it to a message. */
  error?: unknown;
  /** Structured adapter error metadata; only known diagnostic keys are read. */
  adapterErrorMeta?: unknown;
  phase?: "setup" | "execute";
  /** Runtime-only values to redact; never included in the captured event. */
  secretValues?: readonly string[];
  /**
   * The caught native session error. Only an unrecoverable-close settlement is
   * read, as closed labels and counts; its message and stack are never copied.
   */
  nativeCloseFailure?: unknown;
}

export interface RunFailureException {
  name?: string;
  message?: string;
  stack?: string;
  code?: string;
  status?: number;
  requestId?: string;
}

export interface RunFailureDiagnostics {
  execution: Context;
  adapter: Context;
  provider: Context;
  exceptions: RunFailureException[];
  truncatedFields: string[];
}

const ACP_PENDING_TOOL_KIND_LABELS: ReadonlySet<string> = new Set([...ACP_TOOL_KINDS, "unknown"]);

/** Closed ACP tool-kind labels only; any other content drops the whole field. */
function readAcpPendingToolKinds(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return null;
  const kinds = value.split(",");
  return kinds.every((kind) => ACP_PENDING_TOOL_KIND_LABELS.has(kind)) ? value : null;
}

/** One closed ACP tool-kind label, or nothing. */
function readAcpToolKind(value: unknown): string | null {
  return typeof value === "string" && ACP_PENDING_TOOL_KIND_LABELS.has(value) ? value : null;
}

/** How the sandbox agent process session ended, as closed labels and a bounded exit code. */
function readAcpProcessTerminal(result: unknown): Context {
  const source = ACP_PROCESS_TERMINAL_SOURCES.find((label) => label === read(result, "acpProcessTerminalSource"));
  if (!source) return {};
  const fields: Context = { acpProcessTerminalSource: source };
  const outcome = read(result, "acpProcessTerminalOutcome");
  if (outcome === "exit" || outcome === "error") fields.acpProcessTerminalOutcome = outcome;
  const exitCode = read(result, "acpProcessTerminalExitCode");
  if (typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) {
    fields.acpProcessTerminalExitCode = exitCode;
  }
  const signal = ACP_PROCESS_TERMINAL_SIGNALS.find((label) => label === read(result, "acpProcessTerminalSignal"));
  if (signal) fields.acpProcessTerminalSignal = signal;
  return fields;
}

function read(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

const NATIVE_CLOSE_COMMAND_STATUSES: ReadonlySet<unknown> = new Set(["pending", "completed", "failed", "rejected", "indeterminate"]);
const NATIVE_CLOSE_RUNNER_LIFECYCLES: ReadonlySet<unknown> = new Set(["ready", "suspended", "closed", "recoverable_failure"]);

function boundedCount(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Which close-barrier condition failed. Tool identities, digests and provider
 * turn ids stay in the run log; only booleans, fixed labels and counts leave.
 */
function readNativeCloseSettlement(error: unknown): Context | null {
  let candidate = error;
  for (let depth = 0; depth < 4 && candidate && typeof candidate === "object"; depth++) {
    if (read(candidate, "code") === "native_session_close_unrecoverable") break;
    candidate = read(candidate, "cause");
  }
  if (read(candidate, "code") !== "native_session_close_unrecoverable") return null;
  const settlement = read(candidate, "settlement");
  const result: Context = {};
  for (const [field, key] of [["runnerSuspended", "closeRunnerSuspended"], ["providerDrained", "closeProviderDrained"]] as const) {
    const value = read(settlement, field);
    if (typeof value === "boolean") result[key] = value;
  }
  const suspension = read(settlement, "suspensionState");
  const commandStatus = read(suspension, "commandStatus");
  if (NATIVE_CLOSE_COMMAND_STATUSES.has(commandStatus)) result.closeSuspendCommandStatus = commandStatus as string;
  else if (suspension && commandStatus === null) result.closeSuspendCommandStatus = "not_queued";
  const lifecycle = read(suspension, "runnerLifecycle");
  if (NATIVE_CLOSE_RUNNER_LIFECYCLES.has(lifecycle)) result.closeRunnerLifecycle = lifecycle as string;
  else if (suspension && lifecycle === null) result.closeRunnerLifecycle = "unobserved";
  const identityMatches = read(suspension, "runnerIdentityMatches");
  if (typeof identityMatches === "boolean") result.closeRunnerIdentityMatches = identityMatches;
  const provider = read(settlement, "finalProviderState");
  if (provider === null) result.closeProviderState = "not_local";
  else if (provider === "unreadable") result.closeProviderState = "unreadable";
  else if (provider && typeof provider === "object") {
    const settled = read(provider, "providerSettled");
    if (typeof settled === "boolean") result.closeProviderState = settled ? "settled" : "unsettled";
    const pending = boundedCount(read(provider, "pendingEventCount"));
    if (pending !== undefined) result.closeProviderPendingEventCount = pending;
    const activeTurn = read(provider, "activeProviderTurnId");
    if (activeTurn === null || typeof activeTurn === "string") result.closeProviderTurnActive = activeTurn !== null;
  }
  const tools = read(settlement, "semanticTools");
  const persistenceFailed = read(tools, "persistenceFailed");
  if (typeof persistenceFailed === "boolean") result.closeSemanticResultPersistenceFailed = persistenceFailed;
  for (const [field, key] of [
    ["pending", "closeSemanticToolsPending"],
    ["deliveries", "closeSemanticToolDeliveriesOpen"],
    ["failures", "closeSemanticResultFailures"],
  ] as const) {
    const count = boundedCount(read(tools, field));
    if (count !== undefined) result[key] = count;
  }
  return result;
}

function scalars(value: unknown, fields: readonly string[]): Context {
  const result: Context = {};
  for (const field of fields) {
    const entry = read(value, field);
    if (
      typeof entry === "string" || typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) result[field] = entry;
  }
  return result;
}

/** Select credential fields, credential-shaped values, and declared bindings. */
export const collectRunFailureSecretValues = collectDiagnosticEnvironmentSecrets;

/** Redact literal, JSON-escaped and URI-encoded forms without rewriting markers. */
export function redactRunFailureSecretValues<T>(input: T, values: readonly string[]): T {
  const forms = [...new Set(values.filter(Boolean).flatMap((value) => {
    const forms = [value, JSON.stringify(value).slice(1, -1)];
    try { forms.push(encodeURIComponent(value)); } catch { /* malformed Unicode */ }
    return forms;
  }))].sort((a, b) => b.length - a.length);
  if (forms.length === 0) return input;
  const pattern = new RegExp(forms.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gu");
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(pattern, () => REDACTED_EVENT_VALUE);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
    }
    return value;
  };
  return redact(input) as T;
}

/** Snapshot only diagnostics. Never walk a request, response, config or prompt. */
export function collectRunFailureDiagnostics(run: Run, options: RunFailureReportOptions): RunFailureDiagnostics {
  const execution = scalars(run, [
    "runtimeMode", "executionStage", "nativePhase", "driverKind", "driverVersion",
  ]);
  if (options.phase) execution.failurePhase = options.phase;
  const providerConfig = read(read(run.runnerProfileJson, "nativeExecutionInput"), "provider");
  const providerKind = read(providerConfig, "kind");
  const model = read(providerConfig, "model");
  if (typeof providerKind === "string") execution.providerKind = providerKind;
  if (typeof model === "string") execution.model = model;
  for (const field of ["startedAt", "finishedAt"] as const) {
    const value = run[field];
    if (value instanceof Date && Number.isFinite(value.getTime())) execution[field] = value.toISOString();
  }
  const originalFailureCode = read(run.resultJson, "originalFailureCode");
  if (typeof originalFailureCode === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(originalFailureCode)) {
    execution.originalFailureCode = originalFailureCode;
  }
  if (run.startedAt && run.finishedAt) {
    const durationMs = run.finishedAt.getTime() - run.startedAt.getTime();
    if (Number.isFinite(durationMs) && durationMs >= 0) execution.durationMs = durationMs;
  }
  const result = run.resultJson;
  // Restart reattachment can fail before the native coordinator saves its
  // result. The thrown error then reaches the generic run failure path, so
  // read the same closed labels from the error.
  const remoteRunnerRecovery = readRemoteRunnerRecoveryDiagnostic(read(result, "remoteRunnerRecovery")) ??
    readRemoteRunnerRecoveryError(options.error);
  if (remoteRunnerRecovery) {
    execution.remoteRunnerRecoveryStage = remoteRunnerRecovery.stage;
    execution.remoteRunnerRecoveryReason = remoteRunnerRecovery.reason;
    if (remoteRunnerRecovery.runnerLifecycle) execution.remoteRunnerLifecycle = remoteRunnerRecovery.runnerLifecycle;
    if (remoteRunnerRecovery.runnerSettled !== undefined) execution.remoteRunnerSettled = remoteRunnerRecovery.runnerSettled;
  }
  const configuration = read(result, "configurationIncomplete");
  if (run.errorCode === "configuration_incomplete" && read(configuration, "reason") === "workspace_base_ref_unresolved") {
    const diagnostic = readWorkspaceBaseRefDiagnostic(read(configuration, "baseRefDiagnostic"));
    if (diagnostic) {
      for (const [key, value] of Object.entries(diagnostic)) {
        if (key !== "schemaVersion") execution[`workspaceBaseRef${key[0]!.toUpperCase()}${key.slice(1)}`] = value;
      }
    }
  }
  const workspaceValidation = read(result, "workspaceValidation");
  if (run.errorCode === "workspace_validation_failed" && read(workspaceValidation, "reason") === "git_worktree_not_reusable") {
    execution.workspaceValidationReason = "git_worktree_not_reusable";
    const reasonCode = MANAGED_GIT_WORKTREE_REASON_CODES.find(code => code === read(workspaceValidation, "reasonCode"));
    if (reasonCode) execution.workspaceValidationReasonCode = reasonCode;
    const diagnostic = reasonCode === "git_inspection_failed"
      ? readManagedGitInspectionDiagnostic(read(workspaceValidation, "inspectionDiagnostic")) : null;
    if (diagnostic) {
      execution.workspaceValidationInspectionCommand = diagnostic.command;
      execution.workspaceValidationInspectionFailure = diagnostic.failure;
      if (diagnostic.errorCode) execution.workspaceValidationInspectionErrorCode = diagnostic.errorCode;
      if (diagnostic.exitCode !== undefined) execution.workspaceValidationInspectionExitCode = diagnostic.exitCode;
    }
  }
  if (run.errorCode === "workspace_validation_failed" && read(workspaceValidation, "reason") === "persisted_workspace_source_conflict") {
    execution.workspaceValidationReason = "persisted_workspace_source_conflict";
    const reasonCode = PERSISTED_WORKSPACE_SOURCE_REASON_CODES.find(code => code === read(workspaceValidation, "reasonCode"));
    if (reasonCode) execution.workspaceValidationReasonCode = reasonCode;
  }
  if (run.errorCode === "process_lost") {
    const diagnostic = readProcessLossDiagnostic(read(result, "processLossDiagnostic"));
    for (const [field, value] of Object.entries(diagnostic)) {
      execution[`processLoss${field[0]!.toUpperCase()}${field.slice(1)}`] = value;
    }
  }
  const cancellation = readRunCancellation(result);
  if (cancellation) {
    execution.cancellationSource = cancellation.source;
    execution.cancellationExpected = cancellation.expected;
    execution.cancellationInitiatorType = cancellation.initiator.type;
    const leaseLossCause = readControllerLeaseLossCause(cancellation);
    if (leaseLossCause) execution.controllerLeaseLossCause = leaseLossCause;
  } else if (run.status === "cancelled") {
    execution.cancellationSource = "unknown";
    execution.cancellationExpected = false;
  }
  const leaseLoss = readControllerLeaseLoss(read(result, "controllerLeaseLoss"));
  if (leaseLoss) {
    execution.controllerLeaseLossCause = leaseLoss.cause;
    if (leaseLoss.sinceRenewalMs !== undefined) execution.controllerLeaseSinceRenewalMs = leaseLoss.sinceRenewalMs;
    if (leaseLoss.renewalPendingMs !== undefined) execution.controllerLeaseRenewalPendingMs = leaseLoss.renewalPendingMs;
    if (leaseLoss.deadlineLateMs !== undefined) execution.controllerLeaseDeadlineLateMs = leaseLoss.deadlineLateMs;
    if (leaseLoss.renewalCount !== undefined) execution.controllerLeaseRenewalCount = leaseLoss.renewalCount;
  }
  const reviewedChatDenial = run.errorCode === "setup_failed"
    ? readReviewedChatBindingDenialReason(read(result, "reviewedChatBinding")) : null;
  if (reviewedChatDenial) execution.reviewedChatBindingDenialReason = reviewedChatDenial;
  Object.assign(execution, scalars(result, [
    "mode", "stopReason", "timeoutFired", "timeoutSource", "timeoutConfigured",
    "effectiveTimeoutSec", "errorFamily",
  ]));
  for (const field of [
    "acpLastEventAgeMs", "acpObservedEventCount", "acpPendingToolCount",
    "acpLastEventAgeAtStopMs", "acpOldestPendingToolAgeAtStopMs", "acpStalledToolSilentMs",
    "acpPendingToolPermissionRequestedCount", "acpSettledSameKindToolCount",
    "acpSettledSameKindToolPermissionRequestedCount",
  ]) {
    const value = read(result, field);
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) execution[field] = value;
  }
  const closeSettlement = readNativeCloseSettlement(options.nativeCloseFailure);
  if (closeSettlement) Object.assign(execution, closeSettlement);
  Object.assign(execution, readAcpProcessTerminal(result));
  const pendingToolKinds = readAcpPendingToolKinds(read(result, "acpPendingToolKinds"));
  if (pendingToolKinds) execution.acpPendingToolKinds = pendingToolKinds;
  const stalledToolKind = readAcpToolKind(read(result, "acpStalledToolKind"));
  if (stalledToolKind) execution.acpStalledToolKind = stalledToolKind;
  const stalledToolPermissionRequested = read(result, "acpStalledToolPermissionRequested");
  if (typeof stalledToolPermissionRequested === "boolean") {
    execution.acpStalledToolPermissionRequested = stalledToolPermissionRequested;
  }
  const toolInventoryComplete = read(result, "acpToolInventoryComplete");
  if (typeof toolInventoryComplete === "boolean") execution.acpToolInventoryComplete = toolInventoryComplete;
  const restoreFailure = read(result, "workspaceRestoreFailure");
  const restoreCode = WORKSPACE_RESTORE_FAILURE_CODES.find((code) => code === restoreFailure);
  if (restoreCode) {
    execution.workspaceRestoreFailure = restoreCode;
    const diagnostic = sanitizeWorkspaceRestoreDiagnostic(read(result, "workspaceRestoreDiagnostic"));
    if (diagnostic) {
      execution.workspaceRestorePhase = diagnostic.phase;
      execution.workspaceRestoreErrorCode = diagnostic.errorCode;
      if (diagnostic.step) execution.workspaceRestoreStep = diagnostic.step;
      if (diagnostic.httpStatus !== undefined) execution.workspaceRestoreHttpStatus = diagnostic.httpStatus;
      if (diagnostic.exitCode !== undefined) execution.workspaceRestoreExitCode = diagnostic.exitCode;
      if (diagnostic.transferStep) execution.workspaceRestoreTransferStep = diagnostic.transferStep;
      if (diagnostic.transferFailureKind) execution.workspaceRestoreTransferFailureKind = diagnostic.transferFailureKind;
      if (diagnostic.rpcCode !== undefined) execution.workspaceRestoreRpcCode = diagnostic.rpcCode;
      if (diagnostic.gitCommand) execution.workspaceRestoreGitCommand = diagnostic.gitCommand;
      if (diagnostic.gitFailureKind) execution.workspaceRestoreGitFailureKind = diagnostic.gitFailureKind;
    }
  }
  const adapter = scalars(options.adapterErrorMeta, [
    "category", "phase", "errorName", "acpCode", "causeMessage", "retryable",
    "stackPreview", "status", "statusCode", "requestId",
  ]);
  const provider = scalars(read(result, "terminalSessionFailure"), ["category", "title", "details"]);
  const nativeProviderFailure = readNativeModelRejectionDiagnostic(read(result, "nativeProviderFailure"));
  if (nativeProviderFailure) Object.assign(provider, nativeProviderFailure);
  const nativeTurnFailure = readNativeTurnFailureDiagnostic(read(result, "nativeTurnFailure"));
  if (nativeTurnFailure) Object.assign(provider, nativeTurnFailure);
  const truncatedFields: string[] = [];
  const providerTruncation = read(read(result, "terminalSessionFailure"), "truncatedFields");
  if (Array.isArray(providerTruncation)) {
    for (const field of ["title", "details"]) {
      if (providerTruncation.includes(field)) truncatedFields.push(`provider.${field}`);
    }
  }
  const exceptions: RunFailureException[] = [];
  const seen = new Set<unknown>();
  let error = options.error;
  while (error !== undefined && error !== null && exceptions.length < 4) {
    if (seen.has(error)) {
      truncatedFields.push("exceptions.cycle");
      break;
    }
    seen.add(error);
    if (typeof error === "string") {
      exceptions.push({ message: error });
      error = undefined;
      break;
    }
    if (typeof error !== "object") break;
    const acquisition = options.phase === "setup" && run.errorCode === "setup_failed"
      ? getEnvironmentAcquisitionDiagnostic(error, run) : null;
    if (acquisition && execution.environmentAcquisitionPhase === undefined) {
      execution.environmentAcquisitionPhase = acquisition.phase;
      execution.environmentAcquisitionElapsedMs = acquisition.elapsedMs;
      execution.environmentAcquisitionBudgetMs = acquisition.budgetMs;
      if (acquisition.providerState) execution.environmentAcquisitionProviderState = acquisition.providerState;
    }
    const lock = execution.restoreLockOwnerState === undefined ? directoryMergeLockTimeoutDiagnosticsFor(error) : null;
    for (const [field, value] of Object.entries(lock ?? {})) {
      execution[`restoreLock${field[0]!.toUpperCase()}${field.slice(1)}`] = value;
    }
    // A bare socket error ("aborted", ECONNRESET) cannot say which storage
    // read it interrupted; the provider's fixed-shape record can.
    const storage = storageFailureDiagnosticsFor(error);
    if (storage && execution.storageOperation === undefined) {
      execution.storageProvider = storage.provider;
      execution.storageOperation = storage.operation;
      execution.storageErrorCode = storage.errorCode;
      if (storage.httpStatus !== null) execution.storageHttpStatus = storage.httpStatus;
      if (storage.requestId !== null) execution.storageRequestId = storage.requestId;
      if (storage.attempts !== null) execution.storageAttempts = storage.attempts;
    }
    const entry: RunFailureException = {};
    for (const field of ["name", "message", "stack", "code"] as const) {
      const value = read(error, field);
      if (typeof value === "string") entry[field] = value;
      else if (field === "code" && typeof value === "number" && Number.isFinite(value)) entry.code = String(value);
    }
    if (entry.code === undefined) {
      const reasonCode = read(error, "reasonCode");
      if (typeof reasonCode === "string") entry.code = reasonCode;
    }
    const status = read(error, "status") ?? read(error, "statusCode");
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) entry.status = status;
    const requestId = read(error, "requestId") ?? read(error, "request_id");
    if (typeof requestId === "string") entry.requestId = requestId;
    if (Object.keys(entry).length > 0) exceptions.push(entry);
    else break;
    error = read(error, "cause");
  }
  if (error !== undefined && error !== null && exceptions.length === 4) truncatedFields.push("exceptions.depth");
  return { execution, adapter, provider, exceptions, truncatedFields };
}

/** Redact complete values before cutting, including credentials across a cut. */
export function sanitizeRunFailureText(input: string, limit: number): string {
  const normalized = input
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/[\ud800-\udfff]/gu, "\ufffd");
  const clean = redactSensitiveText(redactDiagnosticText(redactCurrentUserText(normalized)));
  if (clean.length <= limit) return clean;
  const suffix = "\n[truncated]";
  let end = limit - suffix.length;
  if ((clean.codePointAt(end - 1) ?? 0) > 0xffff) end--;
  return clean.slice(0, end) + suffix;
}

/** Called after the run's registered secret values have also been removed. */
export function sanitizeRunFailureDiagnostics(raw: RunFailureDiagnostics): RunFailureDiagnostics {
  const truncatedFields = [...raw.truncatedFields];
  const text = (value: string, path: string, limit: number) => {
    const sanitized = sanitizeRunFailureText(value, limit);
    if (sanitized.endsWith("\n[truncated]")) truncatedFields.push(path);
    return sanitized;
  };
  const context = (value: Context, prefix: string, limits: Record<string, number> = {}): Context =>
    Object.fromEntries(Object.entries(value).map(([key, value]) => [key,
      typeof value === "string" ? text(value, `${prefix}.${key}`, limits[key] ?? 200) : value,
    ]));
  return {
    execution: context(raw.execution, "execution"),
    adapter: context(raw.adapter, "adapter", { causeMessage: 2048, stackPreview: 8192 }),
    provider: context(raw.provider, "provider", { title: 4096, details: 12288 }),
    exceptions: raw.exceptions.map((entry, i) => context(entry as Context, `exceptions.${i}`, { message: 2048, stack: 8192 })),
    truncatedFields: [...new Set(truncatedFields)],
  };
}

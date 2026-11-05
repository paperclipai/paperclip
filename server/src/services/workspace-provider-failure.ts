import {
  JsonRpcCallError,
  PLUGIN_RPC_ERROR_CODES,
  readWorkspaceOperationFailureReason,
  type PluginWorkspaceOperationFailureReason,
} from "@paperclipai/plugin-sdk";
import { HttpError } from "../errors.js";
import { findPluginWorkerUnavailableError } from "./plugin-worker-unavailable-error.js";

/**
 * How a `workspaceOperation` call failed.
 * - `worker_unavailable`: the worker was not running, so no request was sent.
 * - `timeout`: no reply arrived in time; the operation may still have run.
 * - `worker_exited`: the worker stopped with the call pending; the operation may have run.
 * - `transport`: any other failure before a reply; the outcome is unknown.
 * - `provider`: the provider replied with an error.
 */
export type WorkspaceProviderFailureKind = "worker_unavailable" | "timeout" | "worker_exited" | "transport" | "provider";

const INCOMPLETE = "Workspace storage operation is incomplete; retry the same workspace";

/** Core owns every message. Provider text and values never reach the run, the log or the API. */
const REASONS: Record<PluginWorkspaceOperationFailureReason, { message: string; retryable: boolean }> = {
  unsupported_operation: { retryable: false,
    message: "Workspace storage provider does not support this workspace operation" },
  configuration_unavailable: { retryable: false,
    message: "Workspace storage provider configuration is unavailable; an operator must fix it before retrying" },
  credential_unavailable: { retryable: false,
    message: "Workspace storage provider cannot use the project's Git credential; reconnect it before retrying" },
  storage_grant_unavailable: { retryable: false,
    message: "Project storage access is unavailable or out of date; reconcile the project's storage before retrying" },
  binding_mismatch: { retryable: false,
    message: "Saved workspace storage no longer matches this workspace; retrying the same workspace will not help" },
  storage_pending: { retryable: true,
    message: "Project storage is still being prepared; retry the same workspace shortly" },
  runtime_unavailable: { retryable: true,
    message: "The selected runtime is not ready; retry the same workspace once it is ready" },
  runtime_connection_invalid: { retryable: false,
    message: "The selected runtime's saved connection is invalid; reprovision the runtime before retrying" },
  remote_incomplete: { retryable: true, message: INCOMPLETE },
  context_changed: { retryable: true,
    message: "Workspace storage changed during the operation; retry the same workspace" },
  deadline_exceeded: { retryable: true,
    message: "Workspace storage operation expired; retry the same workspace" },
};

/** A failed `workspaceOperation` call, with a bounded kind and reason. */
export class WorkspaceProviderFailureError extends HttpError {
  readonly kind: WorkspaceProviderFailureKind;
  readonly reason: PluginWorkspaceOperationFailureReason | null;
  readonly retryable: boolean;

  constructor(input: { kind: WorkspaceProviderFailureKind; reason?: PluginWorkspaceOperationFailureReason | null;
    retryable: boolean; message: string; cause?: unknown }) {
    const reason = input.reason ?? null;
    super(409, input.message, { code: "workspace_provider_failed", kind: input.kind, reason, retryable: input.retryable });
    this.name = "WorkspaceProviderFailureError";
    this.kind = input.kind;
    this.reason = reason;
    this.retryable = input.retryable;
    if (input.cause !== undefined) this.cause = input.cause;
  }

  /** Bounded fields for run results and logs. */
  summary() {
    return { kind: this.kind, reason: this.reason, retryable: this.retryable };
  }
}

/**
 * Classify a rejected `workspaceOperation` call. A provider error never passes
 * its message or data through; only a reason from the SDK's closed set does.
 */
export function workspaceProviderCallFailure(error: unknown): WorkspaceProviderFailureError {
  const unavailable = findPluginWorkerUnavailableError(error);
  // Keep the refusal as the cause so setup can retry it: no request reached the provider.
  if (unavailable) return new WorkspaceProviderFailureError({ kind: "worker_unavailable", retryable: true,
    message: "Workspace storage provider is not running; retry the same workspace", cause: unavailable });
  if (!(error instanceof JsonRpcCallError)) return new WorkspaceProviderFailureError({ kind: "transport", retryable: true, message: INCOMPLETE });
  if (error.code === PLUGIN_RPC_ERROR_CODES.TIMEOUT) return new WorkspaceProviderFailureError({ kind: "timeout", retryable: true,
    message: "Workspace storage operation timed out; retry the same workspace" });
  if (error.code === PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE) return new WorkspaceProviderFailureError({ kind: "worker_exited", retryable: true,
    message: "Workspace storage provider stopped during the operation; retry the same workspace" });
  const reason = readWorkspaceOperationFailureReason(error);
  if (!reason) return new WorkspaceProviderFailureError({ kind: "provider", retryable: true,
    message: "Workspace storage provider reported a failure; retry the same workspace" });
  return new WorkspaceProviderFailureError({ kind: "provider", reason, ...REASONS[reason] });
}

/** Find a provider call failure through setup's error wrappers. */
export function findWorkspaceProviderFailure(error: unknown): WorkspaceProviderFailureError | null {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    if (cause instanceof WorkspaceProviderFailureError) return cause;
  }
  return null;
}

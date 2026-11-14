/**
 * Why a workspace provider refused or failed a `workspaceOperation`. The set is
 * closed: Core decides the user-facing message and whether retrying the same
 * workspace can help, so a provider never sends text or values across the bridge.
 */
export const WORKSPACE_OPERATION_FAILURE_REASONS = [
  /** The provider does not accept this operation or request shape. */
  "unsupported_operation",
  /** The provider's own settings are missing or invalid. */
  "configuration_unavailable",
  /** A credential the operation needs (for example the project's Git credential) is unusable. */
  "credential_unavailable",
  /** Saved storage access grants are missing or no longer match the project. */
  "storage_grant_unavailable",
  /** The saved workspace binding does not match this workspace or generation. */
  "binding_mismatch",
  /** Project storage is still being provisioned or reconciled. */
  "storage_pending",
  /** The selected runtime is not ready. */
  "runtime_unavailable",
  /** The selected runtime's saved connection is invalid. */
  "runtime_connection_invalid",
  /** A remote storage or runtime request failed or returned an unusable result. */
  "remote_incomplete",
  /** The runtime, grants or binding changed while the operation ran. */
  "context_changed",
  /** The operation deadline passed. */
  "deadline_exceeded",
] as const;
export type PluginWorkspaceOperationFailureReason = typeof WORKSPACE_OPERATION_FAILURE_REASONS[number];

const SCHEMA = "paperclip/workspace-operation-error/v1";

function ownField(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try { return Object.getOwnPropertyDescriptor(value, name)?.value; }
  catch { return undefined; }
}

function validateReason(value: unknown): PluginWorkspaceOperationFailureReason | null {
  return WORKSPACE_OPERATION_FAILURE_REASONS.includes(value as PluginWorkspaceOperationFailureReason)
    ? value as PluginWorkspaceOperationFailureReason : null;
}

/**
 * Throw from `onWorkspaceOperation` to tell Core why the operation failed. Any
 * error with an own `workspaceFailureReason` from the closed set is forwarded the
 * same way; the message stays local to the worker's RPC error text.
 */
export class PluginWorkspaceOperationError extends Error {
  readonly workspaceFailureReason: PluginWorkspaceOperationFailureReason;

  constructor(reason: PluginWorkspaceOperationFailureReason, message = "Workspace operation failed") {
    const safe = validateReason(reason);
    if (!safe) throw new TypeError("Unknown workspace operation failure reason");
    super(message);
    this.name = "PluginWorkspaceOperationError";
    this.workspaceFailureReason = safe;
  }
}

/** Worker side: copy only the closed reason, never provider text or identities. */
export function workspaceOperationErrorData(error: unknown): { schema: string; reason: PluginWorkspaceOperationFailureReason } | undefined {
  const reason = validateReason(ownField(error, "workspaceFailureReason"));
  return reason ? { schema: SCHEMA, reason } : undefined;
}

/** Host side: validate the envelope again after the worker RPC, through wrapper causes. */
export function readWorkspaceOperationFailureReason(error: unknown): PluginWorkspaceOperationFailureReason | null {
  for (let current = error, depth = 0; current && depth < 5; current = ownField(current, "cause"), depth++) {
    const data = ownField(current, "data");
    if (ownField(data, "schema") === SCHEMA) {
      const reason = validateReason(ownField(data, "reason"));
      if (reason) return reason;
    }
  }
  return null;
}

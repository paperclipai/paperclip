/**
 * Reattaching a remote native run proves that the original sandbox lease, its
 * workspace, and its runner are still the ones the run saved. When a check
 * fails, the run fails with `native_remote_recovery_lease_mismatch`. The detail
 * names the step and the identity field that differed, using closed values
 * only (no identifiers), so an operator can tell which check failed.
 *
 * Consumers match the code exactly or as the `code: detail` prefix.
 */
export const NATIVE_REMOTE_RECOVERY_LEASE_MISMATCH = "native_remote_recovery_lease_mismatch";

export type RemoteRecoveryLeaseMismatchStage =
  | "workspace_preparation"
  | "environment_acquire"
  | "environment_resume"
  | "workspace_sync"
  | "runner_verification";

export type RemoteRecoveryLeaseMismatchField =
  | "run_id"
  | "workspace_reference"
  | "lease"
  | "lease_scope"
  | "lease_status"
  | "lease_expired"
  | "environment_driver"
  | "provider"
  | "provider_lease_id"
  | "remote_cwd"
  | "plugin_task"
  | "target"
  | "replacement_sandbox"
  | "identity_run_id"
  | "identity_session_id";

export function remoteRecoveryLeaseMismatch(
  stage: RemoteRecoveryLeaseMismatchStage,
  field: RemoteRecoveryLeaseMismatchField,
): Error {
  return new Error(`${NATIVE_REMOTE_RECOVERY_LEASE_MISMATCH}: stage=${stage} field=${field}`);
}

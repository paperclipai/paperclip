import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { isSandboxDiskFullFailure } from "../../vendor/paperclip-runner/index.js";
import { isSandboxDiskFullText } from "./remote-runner-disk-reserve.js";

export const NATIVE_SANDBOX_DISK_FULL = "sandbox_disk_full" as const;

export const NATIVE_SANDBOX_DISK_FULL_ACTION =
  "The agent filled the disk of its computer, so its runner stopped. Paperclip does not repeat this automatically: "
  + "a new computer has the same disk size, and the same work would fill it again. Ask the agent to use less disk space, "
  + "for example by deleting build output, caches or dependencies it no longer needs, then press Retry.";

const CODES_THAT_KEEP_THEIR_MEANING: ReadonlySet<string> = new Set([
  "native_permission_declined",
  "native_provider_approval_required",
  "native_provider_usage_limit",
  "native_provider_model_rejected",
  "native_provider_runtime_missing",
  "native_provider_state_incompatible",
  "native_provider_side_effect_pending",
  "native_provider_startup_rejected",
  "native_event_replay_conflict",
  "native_session_cleanup_quarantined",
  "native_governed_wait_settlement_pending",
  "native_predecessor_retirement_unproven",
  "native_adopted_runner_authentication_timeout",
  "native_controller_journal_behind_runner",
  "native_current_wake_comments_unread",
  "native_current_wake_comments_changed_after_read",
  "runner_task_admission_rejected",
  "runner_ingress_access_rejected",
  "runner_remote_provider_artifact_incompatible",
  "planning_mode_unsupported",
]);

const NAMED_DISK_FULL_FAILURE = /(?:^|: )sandbox_disk_full: /;

export function isNativeSandboxDiskFullReport(text: string): boolean {
  return isSandboxDiskFullText(text) || NAMED_DISK_FULL_FAILURE.test(text);
}

function diskFullCause(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 5) return false;
  if (isSandboxDiskFullFailure(error)) return true;
  const value = error as { cause?: unknown; errors?: unknown; message?: unknown };
  if (typeof value.message === "string" && NAMED_DISK_FULL_FAILURE.test(value.message)) return true;
  return diskFullCause(value.cause, depth + 1)
    || (Array.isArray(value.errors) && value.errors.slice(0, 3).some(item => diskFullCause(item, depth + 1)));
}

function sandboxProviderDiskFullCause(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 5) return false;
  if (isSandboxDiskFullFailure(error)) return true;
  if (error instanceof JsonRpcCallError && error.code === PLUGIN_RPC_ERROR_CODES.WORKER_ERROR
    && isNativeSandboxDiskFullReport(error.message)) return true;
  const value = error as { cause?: unknown; errors?: unknown; message?: unknown };
  if (typeof value.message === "string" && NAMED_DISK_FULL_FAILURE.test(value.message)) return true;
  return sandboxProviderDiskFullCause(value.cause, depth + 1)
    || (Array.isArray(value.errors) && value.errors.slice(0, 3).some(item => sandboxProviderDiskFullCause(item, depth + 1)));
}

export function isSandboxProviderDiskFullError(error: unknown): boolean {
  return sandboxProviderDiskFullCause(error);
}

export function nativeSandboxDiskFullSourceCode<T extends string>(
  code: T,
  error: unknown,
  runnerSandboxDiskFull: boolean,
): T | typeof NATIVE_SANDBOX_DISK_FULL {
  if (CODES_THAT_KEEP_THEIR_MEANING.has(code)) return code;
  return runnerSandboxDiskFull || diskFullCause(error) ? NATIVE_SANDBOX_DISK_FULL : code;
}

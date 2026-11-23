import type { heartbeatRuns } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { isResolvedInteractionContinuationWakeContext } from "../modules/run-dispatch/index.js";
import { STORAGE_UNAVAILABLE_CODE } from "../storage/storage-unavailable.js";
import { ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE } from "./environment-provider-unavailable-error.js";
import { PLUGIN_WORKER_UNAVAILABLE_CODE } from "./plugin-worker-unavailable-error.js";
import { REMOTE_WORKSPACE_PREPARATION_TIMEOUT_CODE, REMOTE_WORKSPACE_RESTORE_FAILED_CODE } from "./remote-workspace-transport.js";
import { REPOSITORY_CATALOG_UNAVAILABLE_CODE } from "./repository-catalog-unavailable-error.js";
import { REUSABLE_SANDBOX_RESUME_FAILED_CODE } from "./reusable-sandbox-resume-error.js";
import { REVIEWED_CHAT_BINDING_NOT_READY } from "./reviewed-chat-binding-diagnostics.js";
import { RUNNER_REVISION_MISMATCH_CODE } from "./runner-revision-mismatch.js";
import { WORKSPACE_GIT_SCAN_ERROR_CODES } from "./workspace-git-operation-scheduler.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

export const TRANSIENT_WORKSPACE_PREPARATION_CODES: readonly string[] = [
  WORKSPACE_GIT_SCAN_ERROR_CODES.timeout, WORKSPACE_GIT_SCAN_ERROR_CODES.saturated,
  REMOTE_WORKSPACE_PREPARATION_TIMEOUT_CODE, REUSABLE_SANDBOX_RESUME_FAILED_CODE,
  REMOTE_WORKSPACE_RESTORE_FAILED_CODE, PLUGIN_WORKER_UNAVAILABLE_CODE,
  RUNNER_REVISION_MISMATCH_CODE, ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE,
  REPOSITORY_CATALOG_UNAVAILABLE_CODE, REVIEWED_CHAT_BINDING_NOT_READY,
  STORAGE_UNAVAILABLE_CODE,
];

export function isTransientWorkspacePreparationCode(code: string | null | undefined): boolean {
  return typeof code === "string" && TRANSIENT_WORKSPACE_PREPARATION_CODES.includes(code);
}

/**
 * The persisted form of the setup-failure decision in run completion: this
 * failed legacy run stopped before provider work with a transient preparation
 * code, so its own bounded retry (scheduleBoundedRetryForRun) continues it.
 * The stranded-task sweep uses it to offer a run whose executor has not
 * scheduled that retry (still settling, or its server stopped) to the same
 * idempotent scheduler instead of escalating it.
 */
export function failedPreparationOwnsBoundedRetry(run: Pick<HeartbeatRun,
  "status" | "runtimeMode" | "nativeSessionId" | "runnerInstanceId" | "errorCode" | "resultJson" | "contextSnapshot">): boolean {
  if (run.status !== "failed" || run.runtimeMode !== "legacy" || run.nativeSessionId !== null || run.runnerInstanceId !== null
    || !isTransientWorkspacePreparationCode(run.errorCode)) return false;
  const recovery = parseObject(run.resultJson?.executionRecovery);
  if (recovery.kind !== "bootstrap" || recovery.providerWorkStarted !== false) return false;
  // A restore failure is retried only when its owner proved it retryable.
  if (run.errorCode === REMOTE_WORKSPACE_RESTORE_FAILED_CODE)
    return parseObject(run.resultJson?.remoteWorkspaceRestore).retryable === true;
  // An accepted interaction keeps its own continuation retry.
  return !((run.errorCode === PLUGIN_WORKER_UNAVAILABLE_CODE || run.errorCode === ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE
    || run.errorCode === REPOSITORY_CATALOG_UNAVAILABLE_CODE || run.errorCode === REVIEWED_CHAT_BINDING_NOT_READY)
    && isResolvedInteractionContinuationWakeContext(run.contextSnapshot));
}

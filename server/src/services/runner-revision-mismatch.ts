import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { readEnvironmentTaskErrorCode } from "@paperclipai/plugin-sdk";
import { RUNNER_REVISION_WAIT_RETRY_REASON } from "../modules/run-dispatch/domain/wake-context.js";

export const RUNNER_REVISION_MISMATCH_CODE = "runner_revision_mismatch";

export { RUNNER_REVISION_WAIT_RETRY_REASON };

export const RUNNER_REVISION_MISMATCH_RETRY = {
  retryReason: RUNNER_REVISION_WAIT_RETRY_REASON, wakeReason: "runner_revision_retry", maxAttempts: 10, delayMs: 60_000,
} as const;

export function isRunnerRevisionMismatch(error: unknown): boolean {
  return readEnvironmentTaskErrorCode(error) === RUNNER_REVISION_MISMATCH_CODE;
}

export function runnerRevisionMismatchTestResult(adapterType: string, testedAt = new Date().toISOString()): AdapterEnvironmentTestResult {
  return { adapterType, status: "fail", testedAt, checks: [{ code: RUNNER_REVISION_MISMATCH_CODE, level: "error", retryable: true,
    message: "The remote Runner does not match this Paperclip version yet. Paperclip will check again after the Runner update." }] };
}

import { isSandboxDiskFullFailure } from "../../vendor/paperclip-runner/index.js";
import { isSandboxDiskFullText } from "./remote-runner-disk-reserve.js";

export const NATIVE_SANDBOX_DISK_FULL = "sandbox_disk_full" as const;

export const NATIVE_SANDBOX_DISK_FULL_ACTION =
  "The agent filled the disk of its computer, so its runner stopped. Paperclip does not repeat this automatically: "
  + "a new computer has the same disk size, and the same work would fill it again. Ask the agent to use less disk space, "
  + "for example by deleting build output, caches or dependencies it no longer needs, then press Retry.";

const RUNNER_LOSS_CODES: ReadonlySet<string> = new Set([
  "native_provider_terminal_failed",
  "native_runner_process_exited",
  "native_session_interrupted",
  "provider_transport_failed",
  "provider_process_exited",
  "provider_stdout_closed",
  "provider_process_output_closed",
  "provider_request_timeout",
]);

const OBSERVED_RUN_LIMIT = 1_024;
const runsWithDiskFullRunnerExit = new Set<string>();

export function observeNativeRunnerDiagnostic(runId: string, diagnostic: string): void {
  if (!runId || !isSandboxDiskFullText(diagnostic)) return;
  runsWithDiskFullRunnerExit.delete(runId);
  runsWithDiskFullRunnerExit.add(runId);
  if (runsWithDiskFullRunnerExit.size > OBSERVED_RUN_LIMIT)
    runsWithDiskFullRunnerExit.delete(runsWithDiskFullRunnerExit.values().next().value!);
}

export function takeNativeRunnerSandboxDiskFull(runId: string): boolean {
  return runsWithDiskFullRunnerExit.delete(runId);
}

function diskFullCause(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 5) return false;
  if (isSandboxDiskFullFailure(error)) return true;
  const value = error as { cause?: unknown; errors?: unknown };
  return diskFullCause(value.cause, depth + 1)
    || (Array.isArray(value.errors) && value.errors.slice(0, 3).some(item => diskFullCause(item, depth + 1)));
}

export function nativeSandboxDiskFullSourceCode<T extends string>(
  code: T,
  error: unknown,
  runnerSandboxDiskFull: boolean,
): T | typeof NATIVE_SANDBOX_DISK_FULL {
  if (!RUNNER_LOSS_CODES.has(code)) return code;
  return runnerSandboxDiskFull || diskFullCause(error) ? NATIVE_SANDBOX_DISK_FULL : code;
}

import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import {
  attachRemoteRunnerRecoveryDiagnostic,
  RemoteRunnerRecoveryError,
  type RemoteRunnerRecoveryDiagnostic,
} from "./remote-runner-recovery-diagnostics.js";

export const REMOTE_RUNNER_RECOVERY_PROBE_BUDGET_MS = 30_000;
export const REMOTE_RUNNER_PLUGIN_STALL_BUDGET_MS = 180_000;

export function isPluginRpcTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if ((current as { code?: unknown }).code === PLUGIN_RPC_ERROR_CODES.TIMEOUT) return true;
    current = current.cause;
  }
  return false;
}

export interface RemoteRunnerPluginStall {
  deadline: number;
  observed: boolean;
}

export function remoteRunnerPluginStall(cap = Number.POSITIVE_INFINITY): RemoteRunnerPluginStall {
  return { deadline: Math.min(cap, Date.now() + REMOTE_RUNNER_PLUGIN_STALL_BUDGET_MS), observed: false };
}

export async function readRemoteRunnerRecoveryProbe(input: {
  runner: CommandManagedRuntimeRunner;
  request: Parameters<CommandManagedRuntimeRunner["execute"]>[0];
  stage: RemoteRunnerRecoveryDiagnostic["stage"];
  deadline: number;
  readOnly: boolean;
  stall?: RemoteRunnerPluginStall;
}) {
  let lastError: unknown = new RemoteRunnerRecoveryError({
    stage: input.stage, reason: "probe_timeout",
  });
  const deadline = () => input.readOnly && input.stall?.observed
    ? Math.max(input.deadline, input.stall.deadline)
    : input.deadline;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) break;
    try {
      const result = await input.runner.execute({
        ...input.request,
        timeoutMs: Math.min(10_000, remaining),
      });
      if (!result.timedOut) return result;
      lastError = new RemoteRunnerRecoveryError({ stage: input.stage, reason: "probe_timeout" });
    } catch (error) {
      if (input.readOnly && input.stall && isPluginRpcTimeout(error)) input.stall.observed = true;
      lastError = attachRemoteRunnerRecoveryDiagnostic(error, {
        stage: input.stage, reason: "probe_transport_failed",
      });
    }
    const delayMs = Math.min(250 * 2 ** Math.min(attempt, 3), 2_000);
    if (!input.readOnly || deadline() - Date.now() <= delayMs) break;
    await new Promise<void>(resolve => setTimeout(resolve, delayMs));
  }
  throw lastError;
}

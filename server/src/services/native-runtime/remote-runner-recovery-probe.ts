import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import {
  attachRemoteRunnerRecoveryDiagnostic,
  RemoteRunnerRecoveryError,
  type RemoteRunnerRecoveryDiagnostic,
} from "./remote-runner-recovery-diagnostics.js";

export const REMOTE_RUNNER_RECOVERY_PROBE_BUDGET_MS = 30_000;

export async function readRemoteRunnerRecoveryProbe(input: {
  runner: CommandManagedRuntimeRunner;
  request: Parameters<CommandManagedRuntimeRunner["execute"]>[0];
  stage: RemoteRunnerRecoveryDiagnostic["stage"];
  deadline: number;
  readOnly: boolean;
}) {
  let lastError: unknown = new RemoteRunnerRecoveryError({
    stage: input.stage, reason: "probe_timeout",
  });
  for (let attempt = 0; attempt < (input.readOnly ? 3 : 1); attempt++) {
    const remaining = input.deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const result = await input.runner.execute({
        ...input.request,
        timeoutMs: Math.min(10_000, remaining),
      });
      if (!result.timedOut) return result;
      lastError = new RemoteRunnerRecoveryError({ stage: input.stage, reason: "probe_timeout" });
    } catch (error) {
      lastError = attachRemoteRunnerRecoveryDiagnostic(error, {
        stage: input.stage, reason: "probe_transport_failed",
      });
    }
    if (!input.readOnly || attempt === 2 || input.deadline - Date.now() <= 250) break;
    await new Promise<void>(resolve => setTimeout(resolve, 250));
  }
  throw lastError;
}

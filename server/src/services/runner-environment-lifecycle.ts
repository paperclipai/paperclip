import { resolvePaperclipRunnerIdleTimeoutMs } from "@paperclipai/adapter-utils";
import type { Environment } from "@paperclipai/shared";

function resolveRunnerLifecycleModeForRun(
  config: Record<string, unknown>,
  adapterConfig: Record<string, unknown>,
  admittedLifecycleMode?: "warm" | "per_turn",
): unknown {
  return admittedLifecycleMode ?? (config.runnerLifecycleMode === "warm" || config.runnerLifecycleMode === "per_turn"
    ? config.runnerLifecycleMode
    : adapterConfig.lifecycleMode);
}

/** Resolve runner retention before acquiring a sandbox, not after it is ephemeral.
 * This is a run-scoped view; never persist it over a shared environment's config.
 * The driver still verifies provider support and chooses the actual lease policy.
 */
export function resolveRunnerEnvironmentForRun<T extends Pick<Environment, "driver" | "config">>(
  environment: T,
  adapterType: string,
  adapterConfig: Record<string, unknown> = {},
  admittedLifecycleMode?: "warm" | "per_turn",
  managedAiCredentialIdentity?: string,
): T {
  if (adapterType !== "paperclip_runner" || !["sandbox", "plugin"].includes(environment.driver)) return environment;
  const config = environment.config ?? {};
  const lifecycleMode = resolveRunnerLifecycleModeForRun(config, adapterConfig, admittedLifecycleMode);
  // Warm tasks need a managed credential identity; recovery keeps its admitted policy.
  if (environment.driver === "plugin") return { ...environment, config: { ...config,
    runnerLifecycleMode: admittedLifecycleMode ?? (managedAiCredentialIdentity && lifecycleMode !== "per_turn" ? "warm" : "per_turn"),
    runnerIdleTimeoutMs: resolvePaperclipRunnerIdleTimeoutMs(config.runnerIdleTimeoutMs ?? adapterConfig.idleTimeoutMs),
  } };
  if (lifecycleMode !== "warm") return environment;
  return {
    ...environment,
    config: {
      ...config,
      reuseLease: true,
    },
  };
}

/**
 * The warm runner idle window (ms) a sandbox-provider lease must outlive for
 * this run, or undefined when the run keeps no warm runner on the sandbox. The
 * host forwards it to the provider so a provider idle auto-stop (for example
 * Daytona's `autoStopInterval`) is derived from the same value the host uses
 * for its warm idle timer, instead of an independent default that can match it.
 */
export function resolveWarmRunnerIdleTimeoutMsForRun(
  environment: Pick<Environment, "driver" | "config">,
  adapterType: string,
  adapterConfig: Record<string, unknown> = {},
  admittedLifecycleMode?: "warm" | "per_turn",
): number | undefined {
  if (adapterType !== "paperclip_runner" || environment.driver !== "sandbox") return undefined;
  const config = environment.config ?? {};
  if (resolveRunnerLifecycleModeForRun(config, adapterConfig, admittedLifecycleMode) !== "warm") return undefined;
  return resolvePaperclipRunnerIdleTimeoutMs(config.runnerIdleTimeoutMs ?? adapterConfig.idleTimeoutMs);
}

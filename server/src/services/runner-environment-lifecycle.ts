import { resolvePaperclipRunnerIdleTimeoutMs } from "@paperclipai/adapter-utils";
import type { Environment } from "@paperclipai/shared";
import { REMOTE_RUNNER_RECONNECT_GRACE_MS } from "./native-runtime/native-runner-recovery-contract.js";
import { defaultsRemoteSandboxRunToWarm, resolveWarmProviderSelection } from "./native-runtime/native-warm-capability.js";

/** Facts the remote-sandbox warm default needs beyond the configuration. */
export interface RunnerLifecycleDefaultContext {
  /** The sandbox provider keeps reusable leases (probed before acquisition). */
  reusableLeaseSupported?: boolean;
  /** The run uses a managed AI account. */
  managedAiCredentialIdentity?: string;
}

function explicitLifecycleMode(
  config: Record<string, unknown>,
  adapterConfig: Record<string, unknown>,
  admittedLifecycleMode?: "warm" | "per_turn",
): "warm" | "per_turn" | undefined {
  if (admittedLifecycleMode) return admittedLifecycleMode;
  if (config.runnerLifecycleMode === "warm" || config.runnerLifecycleMode === "per_turn") return config.runnerLifecycleMode;
  if (adapterConfig.lifecycleMode === "warm" || adapterConfig.lifecycleMode === "per_turn") return adapterConfig.lifecycleMode;
  return undefined;
}

/**
 * The remote-sandbox warm default for a run whose lifecycle nobody chose,
 * through the same rule as the native session policy. The harness resolves
 * exactly as the runtime resolves it (an omitted provider is Codex); a config
 * the runtime would refuse gets no default here.
 */
function sandboxRunDefaultsToWarm(
  adapterConfig: Record<string, unknown>,
  context: RunnerLifecycleDefaultContext,
): boolean {
  const profile = resolveWarmProviderSelection(adapterConfig);
  if (!profile) return false;
  return defaultsRemoteSandboxRunToWarm({
    profile,
    reusableLeaseSupported: context.reusableLeaseSupported === true,
    // The attribution is not known here; a harness that needs it for a managed
    // warm session (Copilot) is not a measured default, so this is exact.
    managedAi: context.managedAiCredentialIdentity ? {} : null,
  });
}

function resolveRunnerLifecycleModeForRun(
  environment: Pick<Environment, "driver" | "config">,
  adapterConfig: Record<string, unknown>,
  admittedLifecycleMode: "warm" | "per_turn" | undefined,
  context: RunnerLifecycleDefaultContext,
): unknown {
  const config = environment.config ?? {};
  const explicit = explicitLifecycleMode(config, adapterConfig, admittedLifecycleMode);
  if (explicit) return explicit;
  if (environment.driver === "sandbox" && sandboxRunDefaultsToWarm(adapterConfig, context)) return "warm";
  return adapterConfig.lifecycleMode;
}

/**
 * True when only the provider's reusable-lease support is left to decide this
 * run's sandbox lifecycle, so the caller probes it only for these runs.
 */
export function runnerLifecycleDefaultNeedsLeaseProbe(
  environment: Pick<Environment, "driver" | "config">,
  adapterType: string,
  adapterConfig: Record<string, unknown> = {},
  admittedLifecycleMode?: "warm" | "per_turn",
  managedAiCredentialIdentity?: string,
): boolean {
  if (adapterType !== "paperclip_runner" || environment.driver !== "sandbox") return false;
  if (explicitLifecycleMode(environment.config ?? {}, adapterConfig, admittedLifecycleMode)) return false;
  return sandboxRunDefaultsToWarm(adapterConfig, { reusableLeaseSupported: true, managedAiCredentialIdentity });
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
  defaultContext: Pick<RunnerLifecycleDefaultContext, "reusableLeaseSupported"> = {},
): T {
  if (adapterType !== "paperclip_runner" || !["sandbox", "plugin"].includes(environment.driver)) return environment;
  const config = environment.config ?? {};
  const lifecycleMode = resolveRunnerLifecycleModeForRun(environment, adapterConfig, admittedLifecycleMode,
    { ...defaultContext, managedAiCredentialIdentity });
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
  defaultContext: RunnerLifecycleDefaultContext = {},
): number | undefined {
  if (adapterType !== "paperclip_runner" || environment.driver !== "sandbox") return undefined;
  const config = environment.config ?? {};
  if (resolveRunnerLifecycleModeForRun(environment, adapterConfig, admittedLifecycleMode, defaultContext) !== "warm") return undefined;
  return resolvePaperclipRunnerIdleTimeoutMs(config.runnerIdleTimeoutMs ?? adapterConfig.idleTimeoutMs);
}

/**
 * The remote runner reconnect grace (ms) a sandbox-provider lease must outlive
 * for this run, or undefined when the run places no remote runner on a sandbox.
 * A remote runner keeps working while the controller is offline, and the host
 * reattaches it within this grace. The host forwards it to the provider so a
 * provider idle auto-stop (for example Daytona's `autoStopInterval`) cannot stop
 * the sandbox, and kill the runner, during an outage the host still recovers.
 */
export function resolveRunnerReconnectGraceMsForRun(
  environment: Pick<Environment, "driver">,
  adapterType: string,
): number | undefined {
  if (adapterType !== "paperclip_runner" || environment.driver !== "sandbox") return undefined;
  return REMOTE_RUNNER_RECONNECT_GRACE_MS;
}

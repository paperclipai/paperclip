import type { Environment } from "@paperclipai/shared";

/** The conversation-pod-reuse view of a sandbox environment for one run.
 *
 * Default ON: on a Kubernetes sandbox environment, a turn of an ongoing agent
 * conversation reuses one pod per conversation (one issue, one agent) with the
 * plugin's idle TTL and between-turn scrub. The environment opts OUT with
 * `conversationPodReuse: false` (escape hatch). Plain task runs, routines and
 * timers keep a fresh pod per run, and `paperclip_runner` is never touched.
 *
 * Elsewhere, `reuseLeaseScope: "conversations"` keeps its explicit meaning: a
 * kept-running pod for conversations only; any other run gets a per-turn view.
 *
 * Run-scoped view like {@link resolveRunnerEnvironmentForRun}: never persist it.
 */
export function applyReuseLeaseScope<T extends Pick<Environment, "driver" | "config">>(
  environment: T,
  input: { conversationTurn: boolean; adapterType?: string | null },
): T {
  if (environment.driver !== "sandbox") return environment;
  // paperclip_runner owns its own warm-session retention; never narrow it here.
  if (input.adapterType === "paperclip_runner") return environment;
  const config = environment.config ?? {};
  if (
    input.conversationTurn &&
    config.provider === "kubernetes" &&
    config.conversationPodReuse !== false
  ) {
    return {
      ...environment,
      config: { ...config, reuseLease: true, runnerLifecycleMode: "warm", reuseLeaseScope: "conversations" },
    };
  }
  if (config.reuseLeaseScope !== "conversations" || input.conversationTurn) return environment;
  if (config.reuseLease !== true && config.runnerLifecycleMode !== "warm") return environment;
  return {
    ...environment,
    config: { ...config, reuseLease: false, runnerLifecycleMode: "per_turn" },
  };
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
): T {
  if (adapterType !== "paperclip_runner" || environment.driver !== "sandbox") return environment;
  const config = environment.config ?? {};
  const lifecycleMode = admittedLifecycleMode ?? (config.runnerLifecycleMode === "warm" || config.runnerLifecycleMode === "per_turn"
    ? config.runnerLifecycleMode
    : adapterConfig.lifecycleMode);
  if (lifecycleMode !== "warm") return environment;
  return {
    ...environment,
    config: {
      ...config,
      reuseLease: true,
    },
  };
}

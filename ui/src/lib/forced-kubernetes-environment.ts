import type { Environment, InstanceExecutionMode } from "@paperclipai/shared";

/**
 * Provider key (== plugin driverKey) of the first-party Kubernetes sandbox
 * provider. Mirrors `KUBERNETES_PROVIDER_KEY` in the server-side execution
 * allowlist. Kept local to the UI because the allowlist module lives in the
 * server package and must not be imported by the client bundle.
 */
export const KUBERNETES_PROVIDER_KEY = "kubernetes" as const;

/**
 * True iff the environment is the Kubernetes sandbox provider, i.e. a core
 * `sandbox` driver whose `config.provider` is "kubernetes". Mirrors the
 * server-side `isKubernetesSandboxEnvironment` guard so the UI selects exactly
 * the environment the server forces execution onto.
 */
export function isKubernetesSandboxEnvironment(environment: Environment): boolean {
  if (environment.driver !== "sandbox") return false;
  const provider = environment.config?.provider;
  return provider === KUBERNETES_PROVIDER_KEY;
}

export interface ForcedKubernetesEnvironment {
  /**
   * Whether the instance execution policy forces all execution onto the
   * Kubernetes sandbox. Driven entirely by the `executionMode` instance general
   * setting: `"kubernetes"` forces; `"any"`/absent does not. A self-hoster who
   * keeps the default `"any"` retains the full environment/adapter picker.
   */
  forced: boolean;
  /**
   * The company's managed Kubernetes sandbox environment, if one is present in
   * the loaded environment list. `null` when forced but no such environment is
   * available yet (the UI should show a clear notice rather than silently
   * defaulting to local).
   */
  kubernetesEnvironment: Environment | null;
}

/**
 * Resolve whether execution is forced onto Kubernetes and, if so, which loaded
 * environment is the Kubernetes sandbox. Pure so it can be unit-tested without
 * rendering.
 */
export function resolveForcedKubernetesEnvironment(
  executionMode: InstanceExecutionMode | undefined,
  environments: readonly Environment[],
): ForcedKubernetesEnvironment {
  const forced = executionMode === "kubernetes";
  if (!forced) {
    return { forced: false, kubernetesEnvironment: null };
  }
  const kubernetesEnvironment =
    environments.find((environment) => isKubernetesSandboxEnvironment(environment)) ?? null;
  return { forced: true, kubernetesEnvironment };
}

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

/**
 * Which Execution section to render in the agent config form:
 * - "forced": the instance forces the Kubernetes sandbox — render it read-only.
 * - "loading": the execution policy is still loading — render a placeholder so
 *   a forced-K8s instance never briefly implies unrestricted choice.
 * - "picker": render the full environment picker.
 * - "hidden": no Execution section (environments picker disabled).
 */
export type ExecutionPickerState = "forced" | "loading" | "picker" | "hidden";

export interface ExecutionPickerResolution {
  state: ExecutionPickerState;
  /**
   * True when the execution policy could not be loaded. The picker stays fully
   * usable (an unreachable settings endpoint must never restrict a non-forced
   * instance), but a notice warns that a forced-K8s instance would reject
   * non-Kubernetes environments server-side.
   */
  showPolicyUnknownNotice: boolean;
}

/**
 * Resolve the Execution section state from the execution-policy query status.
 * Pure so the loading/error/forced precedence can be unit-tested without
 * rendering. Deliberately never maps a failed policy load to "forced".
 */
export function resolveExecutionPickerState(input: {
  forced: boolean;
  environmentsEnabled: boolean;
  executionModeLoading: boolean;
  executionModeFailed: boolean;
}): ExecutionPickerResolution {
  if (input.forced) {
    return { state: "forced", showPolicyUnknownNotice: false };
  }
  if (!input.environmentsEnabled) {
    return { state: "hidden", showPolicyUnknownNotice: false };
  }
  if (input.executionModeLoading) {
    return { state: "loading", showPolicyUnknownNotice: false };
  }
  return { state: "picker", showPolicyUnknownNotice: input.executionModeFailed };
}

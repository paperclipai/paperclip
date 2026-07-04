/**
 * Pure execution-allowlist guard.
 *
 * Decides whether a candidate execution environment is permitted to run an
 * agent, given the instance-level execution policy. This is security-critical:
 * on a shared cloud instance we FORCE all untrusted tenant agents onto the
 * Kubernetes sandbox-provider and REFUSE local/in-process execution so that a
 * tenant agent can never run inside the server process or on an unsandboxed
 * local/ssh adapter.
 *
 * The merged tree's environment model represents the Kubernetes sandbox as a
 * core `driver: "sandbox"` environment whose `config.provider` is the plugin's
 * `driverKey` ("kubernetes", `kind: "sandbox_provider"`). The local default is
 * `driver: "local"`. This module knows nothing about the DB or heartbeat — it
 * just maps (driver, provider, policy) -> allow/deny so it is trivially
 * unit-testable.
 */

/** Provider key (== plugin driverKey) of the first-party Kubernetes sandbox provider. */
export const KUBERNETES_PROVIDER_KEY = "kubernetes" as const;

/**
 * Instance execution policy as read from instance general settings.
 *
 * - `"any"` / absent: unrestricted — any environment driver is allowed (the
 *   default, preserves single-tenant / local-trusted behavior).
 * - `"sandbox"`: force *some* sandbox-provider environment (any provider —
 *   Kubernetes, Daytona, E2B, Modal, …); deny local, ssh, and in-process
 *   execution. Provider-agnostic, for cloud instances whose sandbox is not
 *   Kubernetes.
 * - `"kubernetes"`: stricter, provider-pinned variant of `"sandbox"` — force
 *   the Kubernetes sandbox provider specifically and deny every other driver,
 *   including non-Kubernetes sandbox providers.
 */
export interface ExecutionPolicy {
  executionMode?: "kubernetes" | "sandbox" | "any";
}

/**
 * The minimal shape of the selected/candidate environment the guard needs.
 * `driver` is the core `EnvironmentDriver`; `provider` is the sandbox provider
 * key (== plugin driverKey) for `driver: "sandbox"` environments, else null.
 */
export interface ExecutionEnvironmentCandidate {
  driver: string;
  provider: string | null | undefined;
}

export type ExecutionAllowlistDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      deniedDriver: string;
      deniedProvider: string | null;
    };

/** True when the policy pins all execution to the Kubernetes sandbox provider specifically. */
export function isExecutionForcedToKubernetes(policy: ExecutionPolicy | null | undefined): boolean {
  return policy?.executionMode === "kubernetes";
}

/** True when the policy forces some (provider-agnostic) sandbox provider, but not a specific one. */
export function isExecutionForcedToSandbox(policy: ExecutionPolicy | null | undefined): boolean {
  return policy?.executionMode === "sandbox";
}

/**
 * True when the policy forces a sandbox tier of any kind (`"sandbox"` or the
 * provider-pinned `"kubernetes"`) — i.e. local/ssh/in-process execution is
 * refused. Use this to decide whether the heartbeat should override selection
 * onto a sandbox environment; use the more specific predicates above to pick
 * *which* environment to pin to.
 */
export function isExecutionForcedToSandboxTier(policy: ExecutionPolicy | null | undefined): boolean {
  return isExecutionForcedToSandbox(policy) || isExecutionForcedToKubernetes(policy);
}

/** True iff the candidate is any core `sandbox` driver backed by a provider. */
export function isSandboxProviderEnvironment(candidate: ExecutionEnvironmentCandidate): boolean {
  return candidate.driver === "sandbox" && typeof candidate.provider === "string" && candidate.provider.length > 0;
}

/**
 * True iff the candidate environment is the Kubernetes sandbox provider, i.e. a
 * core `sandbox` driver whose provider key is "kubernetes".
 */
export function isKubernetesSandboxEnvironment(
  candidate: ExecutionEnvironmentCandidate,
): boolean {
  return candidate.driver === "sandbox" && candidate.provider === KUBERNETES_PROVIDER_KEY;
}

/**
 * Decide whether the candidate environment may run under the given policy.
 *
 * - `executionMode === "kubernetes"`: ONLY a `sandbox` driver with provider
 *   "kubernetes" is allowed; everything else (local, ssh, plugin, or any
 *   non-Kubernetes sandbox provider) is DENIED.
 * - `executionMode === "sandbox"`: ANY `sandbox` driver backed by a provider is
 *   allowed; local, ssh, and in-process execution are DENIED.
 * - otherwise: everything is allowed.
 */
export function evaluateExecutionAllowlist(
  policy: ExecutionPolicy | null | undefined,
  candidate: ExecutionEnvironmentCandidate,
): ExecutionAllowlistDecision {
  if (!isExecutionForcedToSandboxTier(policy)) {
    return { allowed: true };
  }

  const provider = candidate.provider ?? null;

  if (isExecutionForcedToKubernetes(policy)) {
    if (isKubernetesSandboxEnvironment(candidate)) {
      return { allowed: true };
    }
    const target =
      candidate.driver === "sandbox"
        ? `sandbox provider "${provider ?? "(none)"}"`
        : `"${candidate.driver}" driver`;
    return {
      allowed: false,
      reason:
        `Instance execution policy requires the Kubernetes sandbox provider ` +
        `(executionMode=kubernetes), but the resolved environment uses the ${target}. ` +
        `Untrusted execution on a non-Kubernetes environment is refused.`,
      deniedDriver: candidate.driver,
      deniedProvider: provider,
    };
  }

  // executionMode === "sandbox": any sandbox provider is acceptable.
  if (isSandboxProviderEnvironment(candidate)) {
    return { allowed: true };
  }

  // A `sandbox` driver with no provider is the likeliest misconfiguration, so
  // name that distinctly instead of blaming the (correct) driver.
  const target =
    candidate.driver === "sandbox"
      ? `sandbox driver with no configured provider`
      : `"${candidate.driver}" driver`;
  return {
    allowed: false,
    reason:
      `Instance execution policy requires a sandbox-provider environment ` +
      `(executionMode=sandbox), but the resolved environment uses the ${target}. ` +
      `Untrusted execution outside a sandbox is refused.`,
    deniedDriver: candidate.driver,
    deniedProvider: provider,
  };
}

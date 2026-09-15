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
 * Instance execution policy as read from instance settings.
 *
 * - `executionMode` `"any"` / absent: unrestricted driver selection (the
 *   default, preserves single-tenant / local-trusted behavior).
 * - `executionMode` `"kubernetes"`: force the Kubernetes sandbox provider;
 *   deny local, ssh, and any non-kubernetes sandbox provider.
 * - `managedSandboxOnly`: deny the `local` driver so untrusted agent code
 *   never executes on the tenant's Paperclip-operated container. Unlike
 *   the kubernetes mode this does NOT pin a single provider — the tenant
 *   may still run on the platform-managed sandbox or on their own
 *   sandbox/ssh infrastructure; only in-process/local execution is
 *   refused. This is the run-time backstop behind the local-hiding UI and
 *   the resolver's local→managed redirect: even if selection or a
 *   tenant-set env var reached a `local` environment, the run fails here
 *   rather than executing on Paperclip compute.
 */
export interface ExecutionPolicy {
  executionMode?: "kubernetes" | "any";
  managedSandboxOnly?: boolean;
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

/** True when the policy forces all execution onto the Kubernetes sandbox. */
export function isExecutionForcedToKubernetes(policy: ExecutionPolicy | null | undefined): boolean {
  return policy?.executionMode === "kubernetes";
}

/** True when the policy refuses local (in-process/on-container) execution. */
export function isLocalExecutionDenied(policy: ExecutionPolicy | null | undefined): boolean {
  return policy?.managedSandboxOnly === true;
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
 * When `executionMode === "kubernetes"`, ONLY a `sandbox_provider` driver with
 * provider/driverKey "kubernetes" is allowed; a `local` driver (or any non-k8s
 * sandbox provider, or ssh, or plugin) is DENIED. Otherwise everything is
 * allowed.
 */
export function evaluateExecutionAllowlist(
  policy: ExecutionPolicy | null | undefined,
  candidate: ExecutionEnvironmentCandidate,
): ExecutionAllowlistDecision {
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

  // Managed-sandbox-only refuses the `local` driver specifically: untrusted
  // agent code must never run in-process / on the tenant's Paperclip
  // container. Other drivers (the platform-managed sandbox, or a tenant's
  // own sandbox/ssh infrastructure) stay allowed — this mode hides local
  // and forces the managed default, it does not pin a single provider.
  if (isLocalExecutionDenied(policy) && candidate.driver === "local") {
    return {
      allowed: false,
      reason:
        `Instance execution policy forbids local execution (managed sandbox only), ` +
        `but the resolved environment uses the "local" driver. Untrusted execution on ` +
        `the tenant container is refused; agents run in the platform-managed sandbox.`,
      deniedDriver: candidate.driver,
      deniedProvider: provider,
    };
  }

  return { allowed: true };
}

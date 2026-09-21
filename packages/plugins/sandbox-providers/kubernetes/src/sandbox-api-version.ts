import type { KubeClients } from "./kube-client.js";

/** The API group that kubernetes-sigs/agent-sandbox installs. */
export const SANDBOX_GROUP = "agents.x-k8s.io";
export const SANDBOX_PLURAL = "sandboxes";

/**
 * The Sandbox API versions this plugin can speak, newest first. The plugin
 * writes only `spec.podTemplate`, which both versions accept, so the choice is
 * purely about which one the cluster serves:
 *
 * - agent-sandbox v1.0.0 and later serve `v1beta1` only — `v1alpha1` was removed.
 * - agent-sandbox v0.5.x serve both, with `v1alpha1` marked deprecated.
 *
 * Pinning either one breaks the other half of the installed base, so the plugin
 * asks the cluster instead.
 */
export const SUPPORTED_SANDBOX_VERSIONS = ["v1beta1", "v1alpha1"] as const;

export type SandboxApiVersion = (typeof SUPPORTED_SANDBOX_VERSIONS)[number];

/**
 * One in-flight or resolved lookup per client set. Discovery is a cluster-level
 * fact that does not change during a run, and a lease can touch the Sandbox API
 * several times, so the result is cached against the clients that produced it.
 * Failures are evicted so a transient discovery error does not pin the provider
 * to a stale answer for the life of the worker.
 */
const versionByClients = new WeakMap<KubeClients, Promise<SandboxApiVersion>>();

/**
 * Resolve the Sandbox API version to use against this cluster.
 *
 * Reads the served versions from the API discovery endpoint rather than the CRD
 * object itself: discovery needs no extra RBAC, while reading the
 * CustomResourceDefinition would require cluster-scoped
 * `customresourcedefinitions` access that a tenant-scoped provider credential
 * has no reason to hold.
 */
export async function resolveSandboxApiVersion(
  clients: KubeClients,
): Promise<SandboxApiVersion> {
  const cached = versionByClients.get(clients);
  if (cached) return cached;

  const pending = discoverSandboxApiVersion(clients);
  versionByClients.set(clients, pending);
  pending.catch(() => versionByClients.delete(clients));
  return pending;
}

async function discoverSandboxApiVersion(
  clients: KubeClients,
): Promise<SandboxApiVersion> {
  const groups = await clients.apis.getAPIVersions();
  const group = groups.groups?.find((candidate) => candidate.name === SANDBOX_GROUP);
  if (!group) {
    throw new Error(
      `This cluster does not serve the "${SANDBOX_GROUP}" API group. Install the ` +
        "kubernetes-sigs/agent-sandbox controller, or set the environment config " +
        'field `backend` to "job".',
    );
  }

  const served = new Set((group.versions ?? []).map((version) => version.version));
  const supported = SUPPORTED_SANDBOX_VERSIONS.find((version) => served.has(version));
  if (!supported) {
    const servedList = [...served].sort().join(", ") || "none";
    throw new Error(
      `This cluster serves "${SANDBOX_GROUP}" versions [${servedList}], and this plugin ` +
        `supports [${SUPPORTED_SANDBOX_VERSIONS.join(", ")}]. Upgrade the plugin, or install a ` +
        "kubernetes-sigs/agent-sandbox release that serves one of the supported versions.",
    );
  }
  return supported;
}

/** True when the value is a Sandbox API version this plugin can speak. */
export function isSandboxApiVersion(value: unknown): value is SandboxApiVersion {
  return (
    typeof value === "string" &&
    (SUPPORTED_SANDBOX_VERSIONS as readonly string[]).includes(value)
  );
}

/**
 * The versions a cleanup call may try, newest first.
 *
 * Cleanup must never depend on discovery. A release or destroy call builds a
 * fresh client set, so it cannot reuse the version cached during acquisition,
 * and a discovery endpoint that is unavailable or forbidden would otherwise
 * strand the sandbox, its pod and its Secret. So: use the version the caller
 * recorded on the lease when it has one, fall back to discovery, and fall back
 * again to every supported version when discovery itself fails.
 */
export async function resolveSandboxApiVersionsForCleanup(
  clients: KubeClients,
  known?: unknown,
): Promise<SandboxApiVersion[]> {
  if (isSandboxApiVersion(known)) return [known];
  try {
    return [await resolveSandboxApiVersion(clients)];
  } catch {
    return [...SUPPORTED_SANDBOX_VERSIONS];
  }
}

/** Test seam: drop a cached lookup so a test can resolve again. */
export function resetSandboxApiVersionCacheForTests(clients: KubeClients): void {
  versionByClients.delete(clients);
}

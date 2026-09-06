/**
 * Which version of the kubernetes-sigs/agent-sandbox Sandbox API to address a
 * cluster with.
 *
 * agent-sandbox graduated its APIs to `v1beta1` in v0.5.0 and now serves both
 * versions from one CRD — `v1beta1` as the storage version and `v1alpha1`
 * deprecated-but-served behind a conversion webhook. Clusters running an older
 * controller serve only `v1alpha1`. Hard-coding either version breaks half the
 * installed base, so the plugin discovers what the cluster actually serves and
 * prefers the newest version it knows how to address.
 *
 * The Sandbox manifest this plugin builds sets only `spec.podTemplate`, which
 * is required and identically shaped in both versions, so the same manifest is
 * valid either way. (The graduation replaced `spec.replicas` with
 * `spec.operatingMode`; the plugin sets neither.)
 */

import type { KubeClients } from "./kube-client.js";

/** API group the Sandbox CRD is served under. */
export const SANDBOX_GROUP = "agents.x-k8s.io";

/**
 * Versions this plugin can address, newest first. Resolution picks the first
 * entry the cluster serves.
 */
export const SANDBOX_API_VERSION_PREFERENCE = ["v1beta1", "v1alpha1"] as const;

export type SandboxApiVersion = (typeof SANDBOX_API_VERSION_PREFERENCE)[number];

/** Narrow a value read back from lease metadata (untyped JSON) to a version. */
export function isSandboxApiVersion(value: unknown): value is SandboxApiVersion {
  return (SANDBOX_API_VERSION_PREFERENCE as readonly unknown[]).includes(value);
}

/**
 * Resolution is cached per API-server URL for the worker's lifetime: served
 * versions only change when an operator upgrades the controller, and a worker
 * restart (or a plugin reload) re-discovers. The PROMISE is cached rather than
 * the value so concurrent first callers share a single discovery request.
 */
const cacheByServer = new Map<string, Promise<SandboxApiVersion>>();

/** Test seam: drop every cached resolution. */
export function __clearSandboxApiVersionCache(): void {
  cacheByServer.clear();
}

interface DiscoveryGroupList {
  groups?: { name?: string; versions?: { version?: string }[] }[];
}

/**
 * Resolve the best served version of the Sandbox API on the cluster behind
 * `clients`, keyed by `serverUrl` (the API-server URL the clients talk to).
 *
 * Throws a message naming the fix when the group is absent (controller not
 * installed) or serves nothing this plugin can address (controller too new to
 * still serve `v1alpha1` and too old to be known here). A rejected promise is
 * evicted from the cache so a transient discovery failure does not wedge the
 * worker into permanently failing every lease.
 */
export function resolveSandboxApiVersion(
  clients: KubeClients,
  serverUrl: string,
): Promise<SandboxApiVersion> {
  const cached = cacheByServer.get(serverUrl);
  if (cached) return cached;

  const resolution = (async (): Promise<SandboxApiVersion> => {
    const list = (await clients.apis.getAPIVersions()) as DiscoveryGroupList;
    const group = (list.groups ?? []).find((g) => g.name === SANDBOX_GROUP);
    if (!group) {
      throw new Error(
        `API group ${SANDBOX_GROUP} is not served by this cluster. Install the kubernetes-sigs/agent-sandbox controller, or set backend: "job" to dispatch runs as batch/v1 Jobs instead.`,
      );
    }
    const served = new Set((group.versions ?? []).map((v) => v.version));
    const pick = SANDBOX_API_VERSION_PREFERENCE.find((version) => served.has(version));
    if (!pick) {
      throw new Error(
        `API group ${SANDBOX_GROUP} serves none of [${SANDBOX_API_VERSION_PREFERENCE.join(", ")}] (serves: ${[...served].join(", ") || "nothing"}). Upgrade the agent-sandbox controller, or set backend: "job".`,
      );
    }
    return pick;
  })();

  cacheByServer.set(serverUrl, resolution);
  // Keep the failure out of the cache without turning it into an unhandled
  // rejection: this handler swallows nothing the caller sees, it only evicts.
  resolution.catch(() => {
    if (cacheByServer.get(serverUrl) === resolution) cacheByServer.delete(serverUrl);
  });
  return resolution;
}

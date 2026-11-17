import type { KubeClients } from "./kube-client.js";
import { buildNetworkPolicyManifests } from "./network-policy.js";
import { buildCiliumNetworkPolicyManifest } from "./cilium-network-policy.js";

export interface EnsureTenantInput {
  namespace: string;
  companyId: string;
  paperclipServerNamespace: string;
  serviceAccountAnnotations: Record<string, string>;
  egressMode: "standard" | "cilium";
  egressAllowFqdns: string[];
  egressAllowCidrs: string[];
  resourceQuota: {
    pods: string;
    requestsCpu: string;
    requestsMemory: string;
    limitsCpu: string;
    limitsMemory: string;
  };
}

const SERVICE_ACCOUNT_NAME = "paperclip-tenant-sa";
const ROLE_NAME = "paperclip-tenant-role";
const ROLE_BINDING_NAME = "paperclip-tenant-rb";
const RESOURCE_QUOTA_NAME = "paperclip-quota";
const LIMIT_RANGE_NAME = "paperclip-limits";

/**
 * Lazy tenant provisioning. Each helper checks if the named resource exists
 * and creates it only on 404; if it already exists, it is left as-is — RBAC
 * permissions, network policies and the egress allow-list are FROZEN at first
 * provisioning time.
 *
 * The one exception is the ResourceQuota (`paperclip-quota`): its `spec.hard`
 * is reconciled to the configured values on every (uncached) ensure, so
 * changing `resourceQuota` in the environment config takes effect on existing
 * tenant namespaces at the next lease acquire, with no manual step. A failed
 * update (e.g. the server's RBAC lacks `update` on resourcequotas) is logged
 * and does not fail the run.
 *
 * Limitation: changing any other KubernetesProviderConfig field after a
 * tenant namespace is provisioned does NOT update the in-cluster resources.
 * To apply those, an operator must delete the per-tenant resources manually
 * (or the namespace itself).
 *
 * Particular gotcha: switching egressMode "standard" → "cilium" leaves the
 * old paperclip-egress-allow NetworkPolicy in place alongside the new
 * CiliumNetworkPolicy. Both apply; the effective egress is the intersection.
 */
export async function ensureTenant(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  await ensureNamespace(clients, input);
  await ensureServiceAccount(clients, input);
  await ensureRole(clients, input);
  await ensureRoleBinding(clients, input);
  await ensureResourceQuota(clients, input);
  await ensureLimitRange(clients, input);
  await ensureNetworkPolicies(clients, input);
}

async function ensureNamespace(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.core.readNamespace({ name: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.core.createNamespace({
        body: {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name: input.namespace,
            labels: {
              "paperclip.io/company-id": input.companyId,
              "paperclip.io/managed-by": "paperclip-k8s-plugin",
              "pod-security.kubernetes.io/enforce": "restricted",
              "pod-security.kubernetes.io/audit": "restricted",
              "pod-security.kubernetes.io/warn": "restricted",
            },
          },
        },
      }),
  );
}

async function ensureServiceAccount(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.core.readNamespacedServiceAccount({ name: SERVICE_ACCOUNT_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.core.createNamespacedServiceAccount({
        namespace: input.namespace,
        body: {
          apiVersion: "v1",
          kind: "ServiceAccount",
          metadata: {
            name: SERVICE_ACCOUNT_NAME,
            namespace: input.namespace,
            annotations: input.serviceAccountAnnotations,
            labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" },
          },
        },
      }),
  );
}

async function ensureRole(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.rbac.readNamespacedRole({ name: ROLE_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.rbac.createNamespacedRole({
        namespace: input.namespace,
        body: {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "Role",
          metadata: { name: ROLE_NAME, namespace: input.namespace },
          rules: [
            { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
          ],
        },
      }),
  );
}

async function ensureRoleBinding(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.rbac.readNamespacedRoleBinding({ name: ROLE_BINDING_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.rbac.createNamespacedRoleBinding({
        namespace: input.namespace,
        body: {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "RoleBinding",
          metadata: { name: ROLE_BINDING_NAME, namespace: input.namespace },
          roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: ROLE_NAME },
          subjects: [{ kind: "ServiceAccount", name: SERVICE_ACCOUNT_NAME, namespace: input.namespace }],
        },
      }),
  );
}

function desiredQuotaHard(input: EnsureTenantInput): Record<string, string> {
  return {
    pods: input.resourceQuota.pods,
    "requests.cpu": input.resourceQuota.requestsCpu,
    "requests.memory": input.resourceQuota.requestsMemory,
    "limits.cpu": input.resourceQuota.limitsCpu,
    "limits.memory": input.resourceQuota.limitsMemory,
  };
}

async function ensureResourceQuota(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const desired = desiredQuotaHard(input);
  type QuotaObject = { metadata?: Record<string, unknown>; spec?: { hard?: Record<string, string> } };
  let existing: QuotaObject | null = null;
  try {
    existing = (await clients.core.readNamespacedResourceQuota({
      name: RESOURCE_QUOTA_NAME,
      namespace: input.namespace,
    })) as QuotaObject;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (!existing) {
    await createIgnoringAlreadyExists(
      clients.core.createNamespacedResourceQuota({
        namespace: input.namespace,
        body: {
          apiVersion: "v1",
          kind: "ResourceQuota",
          metadata: { name: RESOURCE_QUOTA_NAME, namespace: input.namespace },
          spec: { hard: desired },
        },
      }),
    );
    return;
  }

  const current = existing.spec?.hard ?? {};
  const upToDate = Object.entries(desired).every(([key, value]) => current[key] === value);
  if (upToDate) return;
  try {
    await clients.core.replaceNamespacedResourceQuota({
      name: RESOURCE_QUOTA_NAME,
      namespace: input.namespace,
      // Minimal body: only identity, the resourceVersion (optimistic lock) and
      // the desired hard limits. Never echo status/managedFields back.
      body: {
        apiVersion: "v1",
        kind: "ResourceQuota",
        metadata: {
          name: RESOURCE_QUOTA_NAME,
          namespace: input.namespace,
          resourceVersion: existing.metadata?.resourceVersion,
        },
        spec: { hard: desired },
      } as never,
    });
  } catch (err) {
    console.warn(
      `[plugin-kubernetes] could not update ResourceQuota ${input.namespace}/${RESOURCE_QUOTA_NAME} to the configured values (the server's Kubernetes credentials need "update" on resourcequotas; the old quota stays in force): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function ensureLimitRange(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.core.readNamespacedLimitRange({ name: LIMIT_RANGE_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.core.createNamespacedLimitRange({
        namespace: input.namespace,
        body: {
          apiVersion: "v1",
          kind: "LimitRange",
          metadata: { name: LIMIT_RANGE_NAME, namespace: input.namespace },
          spec: {
            limits: [
              {
                type: "Container",
                max: { cpu: "4", memory: "8Gi" },
                min: { cpu: "100m", memory: "128Mi" },
                // The k8s client-node type names this `_default` but the actual
                // Kubernetes API field is `default`. We produce a JSON-shape
                // manifest so the cast is safe.
                default: { cpu: "1", memory: "2Gi" },
                defaultRequest: { cpu: "250m", memory: "512Mi" },
              },
            ],
          },
        } as never,
      }),
  );
}

async function ensureNetworkPolicies(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const [denyAll, egressStd] = buildNetworkPolicyManifests({
    namespace: input.namespace,
    paperclipServerNamespace: input.paperclipServerNamespace,
    egressAllowCidrs: input.egressAllowCidrs,
    egressAllowFqdns: input.egressAllowFqdns,
  });

  await ensureNetworkPolicy(clients, input.namespace, denyAll);

  if (input.egressMode === "cilium") {
    const cnp = buildCiliumNetworkPolicyManifest({
      namespace: input.namespace,
      paperclipServerNamespace: input.paperclipServerNamespace,
      egressAllowFqdns: input.egressAllowFqdns,
      egressAllowCidrs: input.egressAllowCidrs,
    });
    await ensureCiliumNetworkPolicy(clients, input.namespace, cnp);
  } else {
    await ensureNetworkPolicy(clients, input.namespace, egressStd);
  }
}

async function ensureNetworkPolicy(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const name = (manifest.metadata as { name: string }).name;
  try {
    await clients.networking.readNamespacedNetworkPolicy({ name, namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.networking.createNamespacedNetworkPolicy({ namespace, body: manifest as never }),
  );
}

async function ensureCiliumNetworkPolicy(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const name = (manifest.metadata as { name: string }).name;
  try {
    await clients.custom.getNamespacedCustomObject({
      group: "cilium.io",
      version: "v2",
      namespace,
      plural: "ciliumnetworkpolicies",
      name,
    });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.custom.createNamespacedCustomObject({
        group: "cilium.io",
        version: "v2",
        namespace,
        plural: "ciliumnetworkpolicies",
        body: manifest,
      }),
  );
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; statusCode?: number };
  return e.code === 404 || e.statusCode === 404;
}

function isAlreadyExists(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; statusCode?: number };
  return e.code === 409 || e.statusCode === 409;
}

// Two concurrent lease acquisitions for a brand-new tenant can both observe
// the 404 read and race the create; a 409 AlreadyExists from the loser means
// the desired state already exists, which is exactly what ensure* wants.
async function createIgnoringAlreadyExists(create: Promise<unknown>): Promise<void> {
  try {
    await create;
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
}

// ── Cached ensure ──────────────────────────────────────────────────────────

// ensureTenant is 8-10 sequential API calls. Namespaces are provisioned once
// and (apart from the quota) never change, so remember per namespace that the
// current desired state was already ensured by this worker. The fingerprint
// covers every input, so a config change (e.g. a new quota) misses the cache
// and reconciles. The TTL bounds staleness if someone deletes the namespace or
// edits the quota out of band.
const TENANT_ENSURE_TTL_MS = 5 * 60_000;
const ensuredTenants = new Map<string, { fingerprint: string; expiresAt: number }>();
// Concurrent acquires for one namespace share a single in-flight ensure.
const inFlightEnsures = new Map<string, { fingerprint: string; promise: Promise<void> }>();

// Key-order-independent serialization, so the same input always fingerprints
// the same regardless of how the caller built the object.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function ensureTenantCached(
  clients: KubeClients,
  input: EnsureTenantInput,
  now: () => number = Date.now,
): Promise<void> {
  const fingerprint = stableStringify(input);
  const hit = ensuredTenants.get(input.namespace);
  if (hit && hit.fingerprint === fingerprint && hit.expiresAt > now()) return;
  const pending = inFlightEnsures.get(input.namespace);
  if (pending && pending.fingerprint === fingerprint) return pending.promise;

  const promise = ensureTenant(clients, input)
    .then(() => {
      // Drop expired entries opportunistically so the map cannot grow without bound.
      for (const [namespace, entry] of ensuredTenants) {
        if (entry.expiresAt <= now()) ensuredTenants.delete(namespace);
      }
      ensuredTenants.set(input.namespace, { fingerprint, expiresAt: now() + TENANT_ENSURE_TTL_MS });
    })
    .finally(() => {
      if (inFlightEnsures.get(input.namespace)?.promise === promise) inFlightEnsures.delete(input.namespace);
    });
  inFlightEnsures.set(input.namespace, { fingerprint, promise });
  return promise;
}

/** Drop the cached ensure for a namespace (or all), e.g. after a 404 on use. */
export function invalidateTenantCache(namespace?: string): void {
  if (namespace) ensuredTenants.delete(namespace);
  else ensuredTenants.clear();
}

// ── Capacity ───────────────────────────────────────────────────────────────

/**
 * Thrown when a company has no pod capacity left in its tenant namespace.
 * There is deliberately no queue: the run fails fast with this message.
 */
export class OverCapacityError extends Error {
  constructor(namespace: string, detail: string) {
    super(
      `Over capacity: company sandbox quota exhausted in namespace ${namespace} (${detail}). ` +
        `Wait for running agent runs to finish, or raise resourceQuota.pods on the sandbox environment.`,
    );
    this.name = "OverCapacityError";
  }
}

/** True when a pod-creation/scheduling message indicates the namespace quota. */
export function isQuotaExceededMessage(message: string | undefined): boolean {
  return typeof message === "string" && /exceeded quota|quota exceeded|forbidden: exceeded/i.test(message);
}

function parseWholeNumber(value: string | undefined): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * Throws OverCapacityError when the namespace's pod quota is already fully
 * used. Cheap (one GET) and decisive: checked before creating a Sandbox so a
 * full company fails in about a second instead of waiting for a pod that the
 * quota will never admit. Best-effort: a missing quota or API error never
 * blocks a run (the bounded Ready wait still applies).
 */
export async function assertPodCapacity(clients: KubeClients, namespace: string): Promise<void> {
  let quota: { status?: { hard?: Record<string, string>; used?: Record<string, string> } };
  try {
    quota = (await clients.core.readNamespacedResourceQuota({
      name: RESOURCE_QUOTA_NAME,
      namespace,
    })) as typeof quota;
  } catch (err) {
    // 404 is normal (no quota object yet). Anything else (RBAC, apiserver)
    // silently disables the pre-check, so say so; Kubernetes still enforces
    // the quota and the bounded Ready wait still applies.
    if (!isNotFound(err)) {
      console.warn(
        `[plugin-kubernetes] could not read ResourceQuota ${namespace}/${RESOURCE_QUOTA_NAME}; skipping the capacity pre-check: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  const hard = parseWholeNumber(quota.status?.hard?.pods);
  const used = parseWholeNumber(quota.status?.used?.pods);
  if (hard !== null && used !== null && used >= hard) {
    throw new OverCapacityError(namespace, `${used} of ${hard} pods in use`);
  }
}

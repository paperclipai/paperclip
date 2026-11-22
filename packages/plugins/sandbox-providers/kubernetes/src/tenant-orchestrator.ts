import { createHash } from "node:crypto";
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
  /** Optional reconciliation cache TTL in ms (defaults to 5 minutes; 0 disables cache). */
  cacheTtlMs?: number;
  /** Optional clock for deterministic unit tests. */
  now?: () => number;
}

const FIELD_MANAGER = "paperclip-k8s-plugin";
const SERVICE_ACCOUNT_NAME = "paperclip-tenant-sa";
const ROLE_NAME = "paperclip-tenant-role";
const ROLE_BINDING_NAME = "paperclip-tenant-rb";
const RESOURCE_QUOTA_NAME = "paperclip-quota";
const LIMIT_RANGE_NAME = "paperclip-limits";
const STANDARD_EGRESS_POLICY_NAME = "paperclip-egress-allow";
const CILIUM_EGRESS_POLICY_NAME = "paperclip-egress-fqdn";

export const DEFAULT_TENANT_CACHE_TTL_MS = 5 * 60 * 1000;

interface TenantCacheEntry {
  fingerprint: string;
  expiresAt: number;
}

const tenantReconcileCache = new Map<string, TenantCacheEntry>();

export function clearTenantReconcileCache(): void {
  tenantReconcileCache.clear();
}

function computeTenantFingerprint(input: EnsureTenantInput): string {
  const canonical = {
    namespace: input.namespace,
    companyId: input.companyId,
    paperclipServerNamespace: input.paperclipServerNamespace,
    serviceAccountAnnotations: Object.entries(input.serviceAccountAnnotations).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    egressMode: input.egressMode,
    egressAllowFqdns: [...input.egressAllowFqdns].sort(),
    egressAllowCidrs: [...input.egressAllowCidrs].sort(),
    resourceQuota: input.resourceQuota,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Reconciles per-tenant Kubernetes resources (Namespace, ServiceAccount, RBAC,
 * ResourceQuota, LimitRange, and NetworkPolicy / CiliumNetworkPolicy).
 *
 * Uses Kubernetes Server-Side Apply (SSA) when `clients.applyServerSide` is
 * available so config updates (quotas, annotations, egress allow-lists, and
 * egressMode switches) reconcile cleanly in place, backed by a 5-minute
 * fingerprint cache to avoid redundant API round-trips under concurrency.
 *
 * Switching `egressMode` between `"standard"` and `"cilium"` applies the new
 * policy BEFORE deleting the stale counterpart (zero-downtime apply-before-delete).
 */
export async function ensureTenant(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const ttlMs = input.cacheTtlMs ?? DEFAULT_TENANT_CACHE_TTL_MS;
  const now = (input.now ?? Date.now)();
  const fingerprint = computeTenantFingerprint(input);

  if (ttlMs > 0) {
    const cached = tenantReconcileCache.get(input.namespace);
    if (cached && cached.fingerprint === fingerprint && cached.expiresAt > now) {
      return;
    }
  }

  await ensureNamespace(clients, input);
  await ensureServiceAccount(clients, input);
  await ensureRole(clients, input);
  await ensureRoleBinding(clients, input);
  await ensureResourceQuota(clients, input);
  await ensureLimitRange(clients, input);
  await ensureNetworkPolicies(clients, input);

  if (ttlMs > 0) {
    tenantReconcileCache.set(input.namespace, {
      fingerprint,
      expiresAt: now + ttlMs,
    });
  }
}

async function ensureNamespace(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const manifest: Record<string, unknown> = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: input.namespace,
      labels: {
        "paperclip.io/company-id": input.companyId,
        "paperclip.io/managed-by": FIELD_MANAGER,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
    },
  };
  if (clients.applyServerSide) {
    await clients.applyServerSide(manifest, FIELD_MANAGER);
    return;
  }
  try {
    await clients.core.readNamespace({ name: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.core.createNamespace({ body: manifest as never }),
  );
}

async function ensureServiceAccount(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const manifest: Record<string, unknown> = {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: SERVICE_ACCOUNT_NAME,
      namespace: input.namespace,
      annotations: input.serviceAccountAnnotations,
      labels: { "paperclip.io/managed-by": FIELD_MANAGER },
    },
  };
  if (clients.applyServerSide) {
    await clients.applyServerSide(manifest, FIELD_MANAGER);
    return;
  }
  try {
    await clients.core.readNamespacedServiceAccount({ name: SERVICE_ACCOUNT_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.core.createNamespacedServiceAccount({
      namespace: input.namespace,
      body: manifest as never,
    }),
  );
}

async function ensureRole(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const manifest: Record<string, unknown> = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    metadata: { name: ROLE_NAME, namespace: input.namespace },
    rules: [
      { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
    ],
  };
  if (clients.applyServerSide) {
    await clients.applyServerSide(manifest, FIELD_MANAGER);
    return;
  }
  try {
    await clients.rbac.readNamespacedRole({ name: ROLE_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.rbac.createNamespacedRole({
      namespace: input.namespace,
      body: manifest as never,
    }),
  );
}

async function ensureRoleBinding(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const manifest: Record<string, unknown> = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: { name: ROLE_BINDING_NAME, namespace: input.namespace },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: ROLE_NAME },
    subjects: [{ kind: "ServiceAccount", name: SERVICE_ACCOUNT_NAME, namespace: input.namespace }],
  };
  if (clients.applyServerSide) {
    await clients.applyServerSide(manifest, FIELD_MANAGER);
    return;
  }
  try {
    await clients.rbac.readNamespacedRoleBinding({ name: ROLE_BINDING_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.rbac.createNamespacedRoleBinding({
      namespace: input.namespace,
      body: manifest as never,
    }),
  );
}

async function ensureResourceQuota(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const manifest: Record<string, unknown> = {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: { name: RESOURCE_QUOTA_NAME, namespace: input.namespace },
    spec: {
      hard: {
        pods: input.resourceQuota.pods,
        "requests.cpu": input.resourceQuota.requestsCpu,
        "requests.memory": input.resourceQuota.requestsMemory,
        "limits.cpu": input.resourceQuota.limitsCpu,
        "limits.memory": input.resourceQuota.limitsMemory,
      },
    },
  };
  if (clients.applyServerSide) {
    await clients.applyServerSide(manifest, FIELD_MANAGER);
    return;
  }
  try {
    await clients.core.readNamespacedResourceQuota({ name: RESOURCE_QUOTA_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.core.createNamespacedResourceQuota({
      namespace: input.namespace,
      body: manifest as never,
    }),
  );
}

async function ensureLimitRange(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const manifest: Record<string, unknown> = {
    apiVersion: "v1",
    kind: "LimitRange",
    metadata: { name: LIMIT_RANGE_NAME, namespace: input.namespace },
    spec: {
      limits: [
        {
          type: "Container",
          max: { cpu: "4", memory: "8Gi" },
          min: { cpu: "100m", memory: "128Mi" },
          default: { cpu: "1", memory: "2Gi" },
          defaultRequest: { cpu: "250m", memory: "512Mi" },
        },
      ],
    },
  };
  if (clients.applyServerSide) {
    await clients.applyServerSide(manifest, FIELD_MANAGER);
    return;
  }
  try {
    await clients.core.readNamespacedLimitRange({ name: LIMIT_RANGE_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await createIgnoringAlreadyExists(
    clients.core.createNamespacedLimitRange({
      namespace: input.namespace,
      body: manifest as never,
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
    // Apply-before-delete: install CiliumNetworkPolicy first, then delete stale standard policy.
    await ensureCiliumNetworkPolicy(clients, input.namespace, cnp);
    await deleteStaleStandardEgressPolicy(clients, input.namespace);
  } else {
    // Apply-before-delete: install standard NetworkPolicy first, then delete stale Cilium policy.
    await ensureNetworkPolicy(clients, input.namespace, egressStd);
    await deleteStaleCiliumEgressPolicy(clients, input.namespace);
  }
}

async function ensureNetworkPolicy(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  if (clients.applyServerSide) {
    await clients.applyServerSide(manifest, FIELD_MANAGER);
    return;
  }
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
  if (clients.applyServerSide) {
    await clients.applyServerSide(manifest, FIELD_MANAGER);
    return;
  }
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

async function deleteStaleStandardEgressPolicy(clients: KubeClients, namespace: string): Promise<void> {
  if (typeof clients.networking?.deleteNamespacedNetworkPolicy !== "function") return;
  try {
    await clients.networking.deleteNamespacedNetworkPolicy({
      name: STANDARD_EGRESS_POLICY_NAME,
      namespace,
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

async function deleteStaleCiliumEgressPolicy(clients: KubeClients, namespace: string): Promise<void> {
  if (typeof clients.custom?.deleteNamespacedCustomObject !== "function") return;
  try {
    await clients.custom.deleteNamespacedCustomObject({
      group: "cilium.io",
      version: "v2",
      namespace,
      plural: "ciliumnetworkpolicies",
      name: CILIUM_EGRESS_POLICY_NAME,
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
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

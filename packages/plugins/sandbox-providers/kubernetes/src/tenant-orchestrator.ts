import { createHash } from "node:crypto";
import type { KubeClients } from "./kube-client.js";
import { buildNetworkPolicyManifests } from "./network-policy.js";
import { buildCiliumNetworkPolicyManifest } from "./cilium-network-policy.js";

export interface AdapterEgressInput {
  adapterType: string;
  allowFqdns: string[];
}

export interface EnsureTenantInput {
  namespace: string;
  companyId: string;
  paperclipServerNamespace: string;
  serviceAccountAnnotations: Record<string, string>;
  egressMode: "standard" | "cilium";
  egressAllowFqdns: string[];
  egressAllowCidrs: string[];
  /**
   * Optional per-adapter FQDN allow-list reconciled as its own adapter-scoped
   * CiliumNetworkPolicy (`paperclip.io/adapter: <adapterType>`) so starting a
   * lease for a new adapter never overwrites domains needed by other running
   * adapters in the same namespace. Passing an empty `allowFqdns` deletes any
   * stale adapter policy so removed domains are never left allowed.
   */
  adapterEgress?: AdapterEgressInput;
  resourceQuota: {
    pods: string;
    requestsCpu: string;
    requestsMemory: string;
    limitsCpu: string;
    limitsMemory: string;
  };
  /** Optional explicit cluster identity override (falls back to `clients.clusterId`). */
  clusterId?: string;
  /** Optional reconciliation cache TTL in ms (defaults to 5 minutes; 0 disables cache). */
  cacheTtlMs?: number;
  /** Optional clock for deterministic unit tests. */
  now?: () => number;
}

export class TenantNamespaceOwnershipError extends Error {
  readonly namespace: string;
  readonly expectedCompanyId: string;
  readonly actualCompanyId: string;

  constructor(namespace: string, expectedCompanyId: string, actualCompanyId: string) {
    super(
      `Refusing to reconcile namespace "${namespace}" for company "${expectedCompanyId}": ` +
        `namespace is already owned by company "${actualCompanyId}".`,
    );
    this.name = "TenantNamespaceOwnershipError";
    this.namespace = namespace;
    this.expectedCompanyId = expectedCompanyId;
    this.actualCompanyId = actualCompanyId;
  }
}

const FIELD_MANAGER = "paperclip-k8s-plugin";
const SERVICE_ACCOUNT_NAME = "paperclip-tenant-sa";
const ROLE_NAME = "paperclip-tenant-role";
const ROLE_BINDING_NAME = "paperclip-tenant-rb";
const RESOURCE_QUOTA_NAME = "paperclip-quota";
const LIMIT_RANGE_NAME = "paperclip-limits";
const STANDARD_EGRESS_POLICY_NAME = "paperclip-egress-allow";
const CILIUM_EGRESS_POLICY_NAME = "paperclip-egress-fqdn";
const CILIUM_ADAPTER_POLICY_PREFIX = "paperclip-egress-adapter-";

export const DEFAULT_TENANT_CACHE_TTL_MS = 5 * 60 * 1000;

interface TenantCacheEntry {
  fingerprint: string;
  egressMode: "standard" | "cilium";
  expiresAt: number;
}

interface AdapterEgressCacheEntry {
  fingerprint: string;
  policyName: string;
  expiresAt: number;
}

const tenantReconcileCache = new Map<string, TenantCacheEntry>();
const adapterEgressCache = new Map<string, AdapterEgressCacheEntry>();
const knownAdapterPoliciesByTenant = new Map<string, Set<string>>();
const tenantReconcileLocks = new Map<string, Promise<void>>();

export function clearTenantReconcileCache(): void {
  tenantReconcileCache.clear();
  adapterEgressCache.clear();
  knownAdapterPoliciesByTenant.clear();
  tenantReconcileLocks.clear();
}

function resolveTenantKey(clients: KubeClients, input: EnsureTenantInput): string {
  const clusterKey = input.clusterId ?? clients.clusterId ?? "default";
  return `${clusterKey}::${input.namespace}`;
}

function sanitizePolicyNameSegment(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return "adapter";
  const maxLen = 63 - CILIUM_ADAPTER_POLICY_PREFIX.length;
  if (cleaned.length <= maxLen) return cleaned;
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${cleaned.slice(0, maxLen - 9).replace(/-+$/, "")}-${hash}`;
}

export function adapterCiliumPolicyName(adapterType: string): string {
  return `${CILIUM_ADAPTER_POLICY_PREFIX}${sanitizePolicyNameSegment(adapterType)}`;
}

async function withTenantLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tenantReconcileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  tenantReconcileLocks.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tenantReconcileLocks.get(key) === chained) {
      tenantReconcileLocks.delete(key);
    }
  }
}

function computeTenantFingerprint(input: EnsureTenantInput): string {
  const hasStandardFqdns =
    input.egressMode === "standard" &&
    (input.egressAllowFqdns.length > 0 || (input.adapterEgress?.allowFqdns.length ?? 0) > 0);
  const canonical = {
    namespace: input.namespace,
    companyId: input.companyId,
    paperclipServerNamespace: input.paperclipServerNamespace,
    serviceAccountAnnotations: Object.entries(input.serviceAccountAnnotations).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    egressMode: input.egressMode,
    egressAllowFqdns: [...input.egressAllowFqdns].sort(),
    hasStandardFqdns,
    egressAllowCidrs: [...input.egressAllowCidrs].sort(),
    resourceQuota: input.resourceQuota,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function computeAdapterEgressFingerprint(adapter: AdapterEgressInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        adapterType: adapter.adapterType,
        allowFqdns: [...adapter.allowFqdns].sort(),
      }),
    )
    .digest("hex");
}

/**
 * Reconciles per-tenant Kubernetes resources (Namespace, ServiceAccount, RBAC,
 * ResourceQuota, LimitRange, and NetworkPolicy / CiliumNetworkPolicy).
 *
 * Uses Kubernetes Server-Side Apply (SSA) when `clients.applyServerSide` is
 * available so config updates (quotas, annotations, egress allow-lists, and
 * egressMode switches) reconcile cleanly in place, backed by a per-cluster
 * 5-minute fingerprint cache and per-(cluster, namespace) serialization lock.
 *
 * Before applying, verifies that an existing Namespace is not owned by a
 * different `paperclip.io/company-id`. Switching `egressMode` between
 * `"standard"` and `"cilium"` applies all replacement policies (shared and
 * adapter-scoped) BEFORE deleting stale counterparts (zero-downtime
 * apply-before-delete).
 */
export async function ensureTenant(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const ttlMs = input.cacheTtlMs ?? DEFAULT_TENANT_CACHE_TTL_MS;
  const nowFn = input.now ?? Date.now;
  const tenantKey = resolveTenantKey(clients, input);
  const tenantFingerprint = computeTenantFingerprint(input);
  const adapterEgress = input.egressMode === "cilium" && input.adapterEgress ? input.adapterEgress : null;
  const adapterCacheKey = adapterEgress
    ? `${tenantKey}::adapter::${adapterEgress.adapterType}`
    : null;
  const adapterFingerprint = adapterEgress ? computeAdapterEgressFingerprint(adapterEgress) : null;

  const isTenantCacheFresh = (now: number): boolean => {
    if (ttlMs <= 0) return false;
    const cached = tenantReconcileCache.get(tenantKey);
    return Boolean(cached && cached.fingerprint === tenantFingerprint && cached.expiresAt > now);
  };

  const isAdapterCacheFresh = (now: number): boolean => {
    if (!adapterCacheKey || !adapterFingerprint) return true;
    if (ttlMs <= 0) return false;
    const cached = adapterEgressCache.get(adapterCacheKey);
    return Boolean(cached && cached.fingerprint === adapterFingerprint && cached.expiresAt > now);
  };

  // Fast path before acquiring lock.
  const initialNow = nowFn();
  if (isTenantCacheFresh(initialNow) && isAdapterCacheFresh(initialNow)) {
    return;
  }

  await withTenantLock(tenantKey, async () => {
    const lockedNow = nowFn();
    const tenantFresh = isTenantCacheFresh(lockedNow);
    const adapterFresh = isAdapterCacheFresh(lockedNow);
    if (tenantFresh && adapterFresh) {
      return;
    }

    const previousEntry = tenantReconcileCache.get(tenantKey);
    const previouslyCilium = previousEntry?.egressMode === "cilium";

    const reconcileAdapterPolicy = async (): Promise<void> => {
      if (!adapterEgress || !adapterCacheKey || !adapterFingerprint) return;
      const policyName = adapterCiliumPolicyName(adapterEgress.adapterType);
      if (adapterEgress.allowFqdns.length > 0) {
        const adapterPolicy = buildCiliumNetworkPolicyManifest({
          name: policyName,
          namespace: input.namespace,
          paperclipServerNamespace: input.paperclipServerNamespace,
          egressAllowFqdns: adapterEgress.allowFqdns,
          egressAllowCidrs: [],
          endpointSelector: {
            "paperclip.io/role": "agent",
            "paperclip.io/adapter": adapterEgress.adapterType,
          },
          includeBaseRules: false,
        });
        await ensureCiliumNetworkPolicy(clients, input.namespace, adapterPolicy);
        let known = knownAdapterPoliciesByTenant.get(tenantKey);
        if (!known) {
          known = new Set<string>();
          knownAdapterPoliciesByTenant.set(tenantKey, known);
        }
        known.add(policyName);
      } else {
        // Empty allowFqdns: delete any stale adapter policy so removed domains are revoked.
        await deleteStaleCiliumEgressPolicy(clients, input.namespace, policyName, false);
        knownAdapterPoliciesByTenant.get(tenantKey)?.delete(policyName);
      }
      if (ttlMs > 0) {
        adapterEgressCache.set(adapterCacheKey, {
          fingerprint: adapterFingerprint,
          policyName,
          expiresAt: lockedNow + ttlMs,
        });
      }
    };

    if (!tenantFresh) {
      await ensureNamespace(clients, input);
      await ensureServiceAccount(clients, input);
      await ensureRole(clients, input);
      await ensureRoleBinding(clients, input);
      await ensureResourceQuota(clients, input);
      await ensureLimitRange(clients, input);
      await ensureNetworkPolicies(
        clients,
        input,
        tenantKey,
        previouslyCilium,
        adapterEgress ? reconcileAdapterPolicy : undefined,
      );

      if (ttlMs > 0) {
        tenantReconcileCache.set(tenantKey, {
          fingerprint: tenantFingerprint,
          egressMode: input.egressMode,
          expiresAt: lockedNow + ttlMs,
        });
      }
    } else if (!adapterFresh) {
      await reconcileAdapterPolicy();
    }
  });
}

function extractNamespaceCompanyId(nsResponse: unknown): string | null {
  if (typeof nsResponse !== "object" || nsResponse === null) return null;
  const obj = nsResponse as {
    metadata?: { labels?: Record<string, string> };
    body?: { metadata?: { labels?: Record<string, string> } };
  };
  const labels = obj.metadata?.labels ?? obj.body?.metadata?.labels;
  const companyId = labels?.["paperclip.io/company-id"];
  return typeof companyId === "string" && companyId.length > 0 ? companyId : null;
}

async function assertNamespaceOwnership(
  clients: KubeClients,
  namespace: string,
  companyId: string,
): Promise<{ exists: boolean }> {
  if (typeof clients.core?.readNamespace !== "function") {
    return { exists: false };
  }
  try {
    const existing = await clients.core.readNamespace({ name: namespace });
    const existingCompanyId = extractNamespaceCompanyId(existing);
    if (existingCompanyId && existingCompanyId !== companyId) {
      throw new TenantNamespaceOwnershipError(namespace, companyId, existingCompanyId);
    }
    return { exists: true };
  } catch (err) {
    if (err instanceof TenantNamespaceOwnershipError) throw err;
    if (isNotFound(err)) return { exists: false };
    throw err;
  }
}

async function ensureNamespace(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const { exists } = await assertNamespaceOwnership(clients, input.namespace, input.companyId);

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
  if (exists) {
    return;
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

async function ensureNetworkPolicies(
  clients: KubeClients,
  input: EnsureTenantInput,
  tenantKey: string,
  previouslyCilium: boolean,
  reconcileAdapterPolicy?: () => Promise<void>,
): Promise<void> {
  const standardFqdns = [
    ...input.egressAllowFqdns,
    ...(input.adapterEgress?.allowFqdns ?? []),
  ];
  const [denyAll, egressStd] = buildNetworkPolicyManifests({
    namespace: input.namespace,
    paperclipServerNamespace: input.paperclipServerNamespace,
    egressAllowCidrs: input.egressAllowCidrs,
    egressAllowFqdns: standardFqdns,
  });

  await ensureNetworkPolicy(clients, input.namespace, denyAll);

  if (input.egressMode === "cilium") {
    const cnp = buildCiliumNetworkPolicyManifest({
      namespace: input.namespace,
      paperclipServerNamespace: input.paperclipServerNamespace,
      egressAllowFqdns: input.egressAllowFqdns,
      egressAllowCidrs: input.egressAllowCidrs,
    });
    // Apply-before-delete: install BOTH the shared CiliumNetworkPolicy and any
    // per-adapter CiliumNetworkPolicy BEFORE deleting the stale standard policy.
    await ensureCiliumNetworkPolicy(clients, input.namespace, cnp);
    if (reconcileAdapterPolicy) {
      await reconcileAdapterPolicy();
    }
    await deleteStaleStandardEgressPolicy(clients, input.namespace);
  } else {
    // Apply-before-delete: install standard NetworkPolicy first, then discover
    // and delete all managed Cilium egress policies (shared + per-adapter).
    await ensureNetworkPolicy(clients, input.namespace, egressStd);
    const ignoreForbidden = !previouslyCilium;
    const staleNames = new Set<string>([CILIUM_EGRESS_POLICY_NAME]);
    const knownAdapters = knownAdapterPoliciesByTenant.get(tenantKey);
    if (knownAdapters) {
      for (const name of knownAdapters) staleNames.add(name);
    }
    if (input.adapterEgress) {
      staleNames.add(adapterCiliumPolicyName(input.adapterEgress.adapterType));
    }
    const discovered = await listManagedCiliumEgressPolicies(
      clients,
      input.namespace,
      ignoreForbidden,
    );
    for (const name of discovered) {
      staleNames.add(name);
    }
    for (const policyName of staleNames) {
      await deleteStaleCiliumEgressPolicy(
        clients,
        input.namespace,
        policyName,
        ignoreForbidden,
      );
    }
    knownAdapterPoliciesByTenant.delete(tenantKey);
    const adapterPrefix = `${tenantKey}::adapter::`;
    for (const key of adapterEgressCache.keys()) {
      if (key.startsWith(adapterPrefix)) {
        adapterEgressCache.delete(key);
      }
    }
  }
}

async function listManagedCiliumEgressPolicies(
  clients: KubeClients,
  namespace: string,
  ignoreForbidden: boolean,
): Promise<string[]> {
  if (typeof clients.custom?.listNamespacedCustomObject !== "function") {
    return [];
  }
  try {
    const resp = (await clients.custom.listNamespacedCustomObject({
      group: "cilium.io",
      version: "v2",
      namespace,
      plural: "ciliumnetworkpolicies",
      labelSelector: `paperclip.io/managed-by=${FIELD_MANAGER}`,
    })) as {
      items?: Array<{ metadata?: { name?: string } }>;
      body?: { items?: Array<{ metadata?: { name?: string } }> };
    };
    const items = resp?.items ?? resp?.body?.items ?? [];
    const names: string[] = [];
    for (const item of items) {
      const name = item?.metadata?.name;
      if (
        typeof name === "string" &&
        (name === CILIUM_EGRESS_POLICY_NAME || name.startsWith(CILIUM_ADAPTER_POLICY_PREFIX))
      ) {
        names.push(name);
      }
    }
    return names;
  } catch (err) {
    if (isNotFound(err)) return [];
    if (ignoreForbidden && isForbidden(err)) return [];
    throw err;
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

async function deleteStaleCiliumEgressPolicy(
  clients: KubeClients,
  namespace: string,
  policyName: string,
  ignoreForbidden: boolean,
): Promise<void> {
  if (typeof clients.custom?.deleteNamespacedCustomObject !== "function") return;
  try {
    await clients.custom.deleteNamespacedCustomObject({
      group: "cilium.io",
      version: "v2",
      namespace,
      plural: "ciliumnetworkpolicies",
      name: policyName,
    });
  } catch (err) {
    if (isNotFound(err)) return;
    if (ignoreForbidden && isForbidden(err)) return;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; statusCode?: number };
  return e.code === 404 || e.statusCode === 404;
}

function isForbidden(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; statusCode?: number };
  return e.code === 403 || e.statusCode === 403;
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

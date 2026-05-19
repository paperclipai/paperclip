import type { KubeClients } from "./kube-client.js";
import { buildNetworkPolicyManifests } from "./network-policy.js";
import { buildCiliumNetworkPolicyManifest } from "./cilium-network-policy.js";
import type { KubernetesProviderConfig } from "./types.js";

export interface EnsureTenantInput {
  namespace: string;
  companyId: string;
  paperclipServerNamespace: string;
  serviceAccountAnnotations: Record<string, string>;
  egressMode: "standard" | "cilium";
  egressAllowFqdns: string[];
  egressAllowCidrs: KubernetesProviderConfig["egressAllowCidrs"];
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
const MAX_REPLACE_ATTEMPTS = 3;

/**
 * Tenant provisioning reconciles the resources this plugin owns. Existing
 * resources are replaced with the desired manifest so quota, RBAC, service
 * account annotations, and egress policy changes take effect on the next run.
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
  const manifest = buildNamespaceManifest(input);
  try {
    await replaceExistingResource(
      () => clients.core.readNamespace({ name: input.namespace }),
      (existing) => clients.core.replaceNamespace({
        name: input.namespace,
        body: withResourceVersion(buildNamespaceManifest(input, existing), existing) as never,
      }),
    );
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    await clients.core.createNamespace({ body: manifest });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    await replaceExistingResource(
      () => clients.core.readNamespace({ name: input.namespace }),
      (existing) => clients.core.replaceNamespace({
        name: input.namespace,
        body: withResourceVersion(buildNamespaceManifest(input, existing), existing) as never,
      }),
    );
  }
}

function buildNamespaceManifest(input: EnsureTenantInput, existing?: unknown): Record<string, unknown> {
  const existingLabels = (existing as { metadata?: { labels?: Record<string, string> } })?.metadata?.labels ?? {};
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: input.namespace,
      labels: {
        ...existingLabels,
        "paperclip.io/company-id": input.companyId,
        "paperclip.io/managed-by": "paperclip-k8s-plugin",
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
    },
  };
}

async function ensureServiceAccount(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const manifest = {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: SERVICE_ACCOUNT_NAME,
      namespace: input.namespace,
      annotations: input.serviceAccountAnnotations,
      labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" },
    },
  };
  try {
    await replaceExistingResource(
      () => clients.core.readNamespacedServiceAccount({ name: SERVICE_ACCOUNT_NAME, namespace: input.namespace }),
      (existing) => clients.core.replaceNamespacedServiceAccount({
        name: SERVICE_ACCOUNT_NAME,
        namespace: input.namespace,
        body: withResourceVersion(manifest, existing) as never,
      }),
    );
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    await clients.core.createNamespacedServiceAccount({ namespace: input.namespace, body: manifest });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    await replaceExistingResource(
      () => clients.core.readNamespacedServiceAccount({ name: SERVICE_ACCOUNT_NAME, namespace: input.namespace }),
      (existing) => clients.core.replaceNamespacedServiceAccount({
        name: SERVICE_ACCOUNT_NAME,
        namespace: input.namespace,
        body: withResourceVersion(manifest, existing) as never,
      }),
    );
  }
}

async function ensureRole(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const manifest = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    metadata: { name: ROLE_NAME, namespace: input.namespace },
    rules: [
      { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
    ],
  };
  try {
    await replaceExistingResource(
      () => clients.rbac.readNamespacedRole({ name: ROLE_NAME, namespace: input.namespace }),
      (existing) => clients.rbac.replaceNamespacedRole({
        name: ROLE_NAME,
        namespace: input.namespace,
        body: withResourceVersion(manifest, existing) as never,
      }),
    );
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    await clients.rbac.createNamespacedRole({ namespace: input.namespace, body: manifest });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    await replaceExistingResource(
      () => clients.rbac.readNamespacedRole({ name: ROLE_NAME, namespace: input.namespace }),
      (existing) => clients.rbac.replaceNamespacedRole({
        name: ROLE_NAME,
        namespace: input.namespace,
        body: withResourceVersion(manifest, existing) as never,
      }),
    );
  }
}

async function ensureRoleBinding(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const manifest = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: { name: ROLE_BINDING_NAME, namespace: input.namespace },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: ROLE_NAME },
    subjects: [{ kind: "ServiceAccount", name: SERVICE_ACCOUNT_NAME, namespace: input.namespace }],
  };
  try {
    await replaceExistingResource(
      () => clients.rbac.readNamespacedRoleBinding({ name: ROLE_BINDING_NAME, namespace: input.namespace }),
      (existing) => clients.rbac.replaceNamespacedRoleBinding({
        name: ROLE_BINDING_NAME,
        namespace: input.namespace,
        body: withResourceVersion(manifest, existing) as never,
      }),
    );
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    await clients.rbac.createNamespacedRoleBinding({ namespace: input.namespace, body: manifest });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    await replaceExistingResource(
      () => clients.rbac.readNamespacedRoleBinding({ name: ROLE_BINDING_NAME, namespace: input.namespace }),
      (existing) => clients.rbac.replaceNamespacedRoleBinding({
        name: ROLE_BINDING_NAME,
        namespace: input.namespace,
        body: withResourceVersion(manifest, existing) as never,
      }),
    );
  }
}

async function ensureResourceQuota(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const manifest = {
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
  try {
    await replaceExistingResource(
      () => clients.core.readNamespacedResourceQuota({ name: RESOURCE_QUOTA_NAME, namespace: input.namespace }),
      (existing) => clients.core.replaceNamespacedResourceQuota({
        name: RESOURCE_QUOTA_NAME,
        namespace: input.namespace,
        body: withResourceVersion(manifest, existing) as never,
      }),
    );
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    await clients.core.createNamespacedResourceQuota({ namespace: input.namespace, body: manifest });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    await replaceExistingResource(
      () => clients.core.readNamespacedResourceQuota({ name: RESOURCE_QUOTA_NAME, namespace: input.namespace }),
      (existing) => clients.core.replaceNamespacedResourceQuota({
        name: RESOURCE_QUOTA_NAME,
        namespace: input.namespace,
        body: withResourceVersion(manifest, existing) as never,
      }),
    );
  }
}

async function ensureLimitRange(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const manifest = {
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
  };
  try {
    await replaceExistingResource(
      () => clients.core.readNamespacedLimitRange({ name: LIMIT_RANGE_NAME, namespace: input.namespace }),
      (existing) => clients.core.replaceNamespacedLimitRange({
        name: LIMIT_RANGE_NAME,
        namespace: input.namespace,
        body: withResourceVersion(manifest, existing) as never,
      }),
    );
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    await clients.core.createNamespacedLimitRange({
      namespace: input.namespace,
      body: manifest as never,
    });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    await replaceExistingResource(
      () => clients.core.readNamespacedLimitRange({ name: LIMIT_RANGE_NAME, namespace: input.namespace }),
      (existing) => clients.core.replaceNamespacedLimitRange({
        name: LIMIT_RANGE_NAME,
        namespace: input.namespace,
        body: withResourceVersion(manifest, existing) as never,
      }),
    );
  }
}

async function ensureNetworkPolicies(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  const [denyAll, egressStd] = buildNetworkPolicyManifests({
    namespace: input.namespace,
    paperclipServerNamespace: input.paperclipServerNamespace,
    egressAllowFqdns: input.egressAllowFqdns,
    egressAllowCidrs: input.egressAllowCidrs,
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
    await deleteNetworkPolicyIfExists(clients, input.namespace, "paperclip-egress-allow");
  } else {
    await ensureNetworkPolicy(clients, input.namespace, egressStd);
    await deleteCiliumNetworkPolicyIfExists(clients, input.namespace, "paperclip-egress-fqdn");
  }
}

async function ensureNetworkPolicy(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const name = (manifest.metadata as { name: string }).name;
  try {
    await replaceExistingResource(
      () => clients.networking.readNamespacedNetworkPolicy({ name, namespace }),
      (existing) => clients.networking.replaceNamespacedNetworkPolicy({
        name,
        namespace,
        body: withResourceVersion(manifest, existing) as never,
      }),
    );
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    await clients.networking.createNamespacedNetworkPolicy({ namespace, body: manifest as never });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    await replaceExistingResource(
      () => clients.networking.readNamespacedNetworkPolicy({ name, namespace }),
      (existing) => clients.networking.replaceNamespacedNetworkPolicy({
        name,
        namespace,
        body: withResourceVersion(manifest, existing) as never,
      }),
    );
  }
}

async function ensureCiliumNetworkPolicy(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const name = (manifest.metadata as { name: string }).name;
  try {
    await replaceExistingResource(
      () => clients.custom.getNamespacedCustomObject({
        group: "cilium.io",
        version: "v2",
        namespace,
        plural: "ciliumnetworkpolicies",
        name,
      }),
      (existing) => clients.custom.replaceNamespacedCustomObject({
        group: "cilium.io",
        version: "v2",
        namespace,
        plural: "ciliumnetworkpolicies",
        name,
        body: withResourceVersion(manifest, existing),
      }),
    );
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    await clients.custom.createNamespacedCustomObject({
      group: "cilium.io",
      version: "v2",
      namespace,
      plural: "ciliumnetworkpolicies",
      body: manifest,
    });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    await replaceExistingResource(
      () => clients.custom.getNamespacedCustomObject({
        group: "cilium.io",
        version: "v2",
        namespace,
        plural: "ciliumnetworkpolicies",
        name,
      }),
      (existing) => clients.custom.replaceNamespacedCustomObject({
        group: "cilium.io",
        version: "v2",
        namespace,
        plural: "ciliumnetworkpolicies",
        name,
        body: withResourceVersion(manifest, existing),
      }),
    );
  }
}

async function deleteNetworkPolicyIfExists(clients: KubeClients, namespace: string, name: string): Promise<void> {
  try {
    await clients.networking.deleteNamespacedNetworkPolicy({ name, namespace });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

async function deleteCiliumNetworkPolicyIfExists(clients: KubeClients, namespace: string, name: string): Promise<void> {
  try {
    await clients.custom.deleteNamespacedCustomObject({
      group: "cilium.io",
      version: "v2",
      namespace,
      plural: "ciliumnetworkpolicies",
      name,
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

function withResourceVersion<T extends Record<string, unknown>>(manifest: T, existing: unknown): T {
  const resourceVersion = (existing as { metadata?: { resourceVersion?: string } })?.metadata?.resourceVersion;
  if (!resourceVersion) return manifest;
  return {
    ...manifest,
    metadata: {
      ...(manifest.metadata as Record<string, unknown>),
      resourceVersion,
    },
  };
}

async function replaceExistingResource(
  readExisting: () => Promise<unknown>,
  replaceExisting: (existing: unknown) => Promise<unknown>,
): Promise<void> {
  let existing = await readExisting();
  for (let attempt = 1; attempt <= MAX_REPLACE_ATTEMPTS; attempt += 1) {
    try {
      await replaceExisting(existing);
      return;
    } catch (err) {
      if (!isConflict(err) || attempt === MAX_REPLACE_ATTEMPTS) {
        throw err;
      }
      existing = await readExisting();
    }
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; statusCode?: number };
  return e.code === 404 || e.statusCode === 404;
}

function isAlreadyExists(err: unknown): boolean {
  return isConflict(err);
}

function isConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; statusCode?: number };
  return e.code === 409 || e.statusCode === 409;
}

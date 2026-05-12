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
 * Lazy, first-write-wins tenant provisioning. Each helper checks if the named
 * resource exists and creates it only on 404; if it already exists, it is
 * left as-is — config-driven values (quota limits, RBAC permissions, network
 * policies, egress allow-list) are FROZEN at first provisioning time.
 *
 * V1 limitation: changing KubernetesProviderConfig after a tenant namespace
 * is provisioned does NOT update the in-cluster resources. To apply config
 * changes, an operator must delete the per-tenant resources manually (or
 * the namespace itself). A future iteration should add strategic-merge
 * reconciliation here.
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
  await clients.core.createNamespace({
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
  });
}

async function ensureServiceAccount(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.core.readNamespacedServiceAccount({ name: SERVICE_ACCOUNT_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await clients.core.createNamespacedServiceAccount({
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
  });
}

async function ensureRole(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.rbac.readNamespacedRole({ name: ROLE_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await clients.rbac.createNamespacedRole({
    namespace: input.namespace,
    body: {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name: ROLE_NAME, namespace: input.namespace },
      rules: [
        { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
      ],
    },
  });
}

async function ensureRoleBinding(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.rbac.readNamespacedRoleBinding({ name: ROLE_BINDING_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await clients.rbac.createNamespacedRoleBinding({
    namespace: input.namespace,
    body: {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: ROLE_BINDING_NAME, namespace: input.namespace },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: ROLE_NAME },
      subjects: [{ kind: "ServiceAccount", name: SERVICE_ACCOUNT_NAME, namespace: input.namespace }],
    },
  });
}

async function ensureResourceQuota(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.core.readNamespacedResourceQuota({ name: RESOURCE_QUOTA_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await clients.core.createNamespacedResourceQuota({
    namespace: input.namespace,
    body: {
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
    },
  });
}

async function ensureLimitRange(clients: KubeClients, input: EnsureTenantInput): Promise<void> {
  try {
    await clients.core.readNamespacedLimitRange({ name: LIMIT_RANGE_NAME, namespace: input.namespace });
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await clients.core.createNamespacedLimitRange({
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
  });
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
  await clients.networking.createNamespacedNetworkPolicy({ namespace, body: manifest as never });
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
  await clients.custom.createNamespacedCustomObject({
    group: "cilium.io",
    version: "v2",
    namespace,
    plural: "ciliumnetworkpolicies",
    body: manifest,
  });
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; statusCode?: number };
  return e.code === 404 || e.statusCode === 404;
}

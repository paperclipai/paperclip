import type { KubernetesApiClient, ResolvedClusterConnection } from "../types.js";
import { deriveNamespaceName } from "./naming.js";
import { buildNamespace, applyNamespace } from "./namespace.js";
import {
  buildAgentServiceAccount, applyAgentServiceAccount,
  buildDriverRoleBinding, applyDriverRoleBinding,
} from "./rbac.js";
import {
  buildResourceQuota, buildLimitRange,
  applyResourceQuota, applyLimitRange,
  type QuotaOverride, type LimitRangeOverride,
} from "./resource-quota.js";
import {
  buildDefaultDenyPolicies, buildAgentEgressPolicy, applyNetworkPolicy,
} from "./network-policy.js";
import {
  buildCiliumAgentEgressPolicy, applyCiliumNetworkPolicy,
} from "./cilium-network-policy.js";
import {
  buildImagePullSecret, applyImagePullSecret,
} from "./image-pull-secret.js";

export interface TenantPolicy {
  quota: QuotaOverride | null;
  limitRange: LimitRangeOverride | null;
  additionalAllowFqdns: string[];
  imageOverrides: Record<string, string> | null;
  /** Cilium DSL — empty array means "no extra restrictions beyond M1 baseline". */
  ciliumDnsAllowlist?: string[];
  /** Cilium DSL — empty array means "no extra CIDR restrictions". */
  ciliumEgressCidrs?: string[];
}

export interface EnsureTenantInput {
  connection: ResolvedClusterConnection;
  company: { id: string; slug: string };
  tenantPolicy: TenantPolicy | null;
  driverServiceAccount: { name: string; namespace: string };
  controlPlane: {
    topology: "in-cluster" | "cross-cluster";
    namespaceLabels: Record<string, string>;
    podLabels: Record<string, string>;
  };
  adapterAllowFqdns: string[];
  /** Resolved registry credentials. If null, no image pull secret is created. */
  imagePullDockerConfigJson: string | null;
}

export interface EnsureTenantResult {
  namespace: string;
  ciliumApplied: boolean;
}

/**
 * Idempotently provision a tenant namespace with all isolation primitives:
 * Namespace → RBAC → ResourceQuota/LimitRange → NetworkPolicies → optional CiliumNetworkPolicy → optional image pull secret.
 *
 * Order matters: the Namespace must be created first because everything else is namespaced.
 * The remaining objects can be in any order, but we prefer the creation order to match the
 * "outer to inner" reading flow for kubectl debuggability (rbac → quota → policies → secrets).
 */
export async function ensureTenantNamespace(
  client: KubernetesApiClient,
  input: EnsureTenantInput,
): Promise<EnsureTenantResult> {
  const namespace = deriveNamespaceName({
    companySlug: input.company.slug,
    companyId: input.company.id,
    prefix: input.connection.defaultNamespacePrefix,
  });

  // 1. Namespace (must come first).
  await applyNamespace(client, buildNamespace({
    name: namespace,
    companyId: input.company.id,
    companySlug: input.company.slug,
  }));

  // 2. RBAC.
  await applyAgentServiceAccount(client, buildAgentServiceAccount({
    namespace, companyId: input.company.id, companySlug: input.company.slug,
  }));
  await applyDriverRoleBinding(client, buildDriverRoleBinding({
    namespace,
    driverServiceAccount: input.driverServiceAccount,
    clusterRoleName: "paperclip-tenant-manager",
    companyId: input.company.id, companySlug: input.company.slug,
  }));

  // 3. Quota & LimitRange.
  await applyResourceQuota(client, buildResourceQuota({
    namespace, companyId: input.company.id, companySlug: input.company.slug,
    override: input.tenantPolicy?.quota ?? null,
  }));
  await applyLimitRange(client, buildLimitRange({
    namespace, companyId: input.company.id, companySlug: input.company.slug,
    override: input.tenantPolicy?.limitRange ?? null,
  }));

  // 4. NetworkPolicies (vanilla — always).
  for (const p of buildDefaultDenyPolicies({
    namespace, companyId: input.company.id, companySlug: input.company.slug,
  })) {
    await applyNetworkPolicy(client, p);
  }
  await applyNetworkPolicy(client, buildAgentEgressPolicy({
    namespace,
    companyId: input.company.id,
    companySlug: input.company.slug,
    topology: input.controlPlane.topology,
    controlPlaneSelector: input.controlPlane.topology === "in-cluster"
      ? { namespaceLabel: input.controlPlane.namespaceLabels, podLabel: input.controlPlane.podLabels }
      : null,
  }));

  // 5. Cilium policy (only when cluster supports it).
  let ciliumApplied = false;
  if (input.connection.capabilities.cilium) {
    await applyCiliumNetworkPolicy(client, buildCiliumAgentEgressPolicy({
      namespace,
      companyId: input.company.id,
      companySlug: input.company.slug,
      adapterAllowFqdns: input.adapterAllowFqdns,
      tenantAllowFqdns: input.tenantPolicy?.additionalAllowFqdns ?? [],
      tenantCiliumDnsAllowlist: input.tenantPolicy?.ciliumDnsAllowlist ?? [],
      tenantCiliumEgressCidrs: input.tenantPolicy?.ciliumEgressCidrs ?? [],
      controlPlaneSelector: input.controlPlane.topology === "in-cluster"
        ? { matchLabels: { ...input.controlPlane.namespaceLabels, ...input.controlPlane.podLabels } }
        : null,
    }));
    ciliumApplied = true;
  }

  // 6. Image pull secret (when registry creds were supplied).
  if (input.imagePullDockerConfigJson) {
    await applyImagePullSecret(client, buildImagePullSecret({
      namespace, companyId: input.company.id, companySlug: input.company.slug,
      dockerConfigJson: input.imagePullDockerConfigJson,
    }));
  }

  return { namespace, ciliumApplied };
}

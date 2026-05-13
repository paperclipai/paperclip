import type { V1ServiceAccount, V1RoleBinding } from "@kubernetes/client-node";
import type { KubernetesApiClient } from "../types.js";
import { tenantBaseLabels } from "./labels.js";

export interface BuildAgentServiceAccountInput {
  namespace: string;
  companyId: string;
  companySlug: string;
}

export function buildAgentServiceAccount(input: BuildAgentServiceAccountInput): V1ServiceAccount {
  return {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: "paperclip-agent",
      namespace: input.namespace,
      labels: tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
    },
    automountServiceAccountToken: false,
  };
}

export interface BuildDriverRoleBindingInput {
  namespace: string;
  driverServiceAccount: { name: string; namespace: string };
  clusterRoleName: string;
  companyId: string;
  companySlug: string;
}

export function buildDriverRoleBinding(input: BuildDriverRoleBindingInput): V1RoleBinding {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: {
      name: "paperclip-driver",
      namespace: input.namespace,
      labels: tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
    },
    subjects: [{
      kind: "ServiceAccount",
      name: input.driverServiceAccount.name,
      namespace: input.driverServiceAccount.namespace,
    }],
    roleRef: {
      kind: "ClusterRole",
      apiGroup: "rbac.authorization.k8s.io",
      name: input.clusterRoleName,
    },
  };
}

export async function applyAgentServiceAccount(client: KubernetesApiClient, sa: V1ServiceAccount): Promise<void> {
  const ns = sa.metadata!.namespace!;
  const name = sa.metadata!.name!;
  try {
    await client.core.readNamespacedServiceAccount(name, ns);
    await client.core.patchNamespacedServiceAccount(name, ns, sa, undefined, undefined, undefined, undefined, undefined, {
      headers: { "Content-Type": "application/strategic-merge-patch+json" },
    } as never);
  } catch (err) {
    if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 404) {
      await client.core.createNamespacedServiceAccount(ns, sa);
      return;
    }
    throw err;
  }
}

export async function applyDriverRoleBinding(client: KubernetesApiClient, rb: V1RoleBinding): Promise<void> {
  const ns = rb.metadata!.namespace!;
  const name = rb.metadata!.name!;
  try {
    const existing = await client.rbac.readNamespacedRoleBinding(name, ns);
    const sameRoleRef =
      existing.body.roleRef?.kind === rb.roleRef.kind &&
      existing.body.roleRef?.name === rb.roleRef.name &&
      existing.body.roleRef?.apiGroup === rb.roleRef.apiGroup;
    if (sameRoleRef) {
      // Idempotent path: roleRef hasn't changed (the common case for ensureTenant
      // re-runs). RoleBinding subjects are mutable, so we patch in place — no
      // delete window, no race where the namespace briefly has no permissions.
      await client.rbac.patchNamespacedRoleBinding(name, ns, rb, undefined, undefined, undefined, undefined, undefined, {
        headers: { "Content-Type": "application/strategic-merge-patch+json" },
      } as never);
      return;
    }
    // roleRef differs — k8s makes roleRef immutable, so we must delete+create.
    // This is the rare path (only fires when an admin renames the bound ClusterRole).
    // If the recreate fails, surface a descriptive error pointing at recovery so
    // the operator knows the tenant has no driver permissions until ensureTenant re-runs.
    await client.rbac.deleteNamespacedRoleBinding(name, ns);
    try {
      await client.rbac.createNamespacedRoleBinding(ns, rb);
    } catch (createErr) {
      throw new Error(
        `RoleBinding ${name} in ${ns} was deleted to change roleRef, but the recreate failed: ` +
          `${(createErr as Error).message}. ` +
          `The tenant namespace currently has NO driver RoleBinding — re-run ensureTenant to recover.`,
      );
    }
  } catch (err) {
    if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 404) {
      await client.rbac.createNamespacedRoleBinding(ns, rb);
      return;
    }
    throw err;
  }
}

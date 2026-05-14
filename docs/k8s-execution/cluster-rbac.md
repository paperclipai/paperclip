---
title: Kubernetes Execution — Cluster RBAC
summary: Reference ClusterRole for the Paperclip driver, per-rule rationale, and ServiceAccount binding templates for in-cluster and cross-cluster topologies
---

The Paperclip driver needs a `ClusterRole` to provision and manage tenant namespaces across the cluster. This document explains every permission in that role, and provides binding templates for both supported topologies.

## Reference ClusterRole

The canonical source is `packages/adapters/kubernetes-execution/manifests/paperclip-tenant-manager-clusterrole.yaml`. Its contents are reproduced here for reference:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: paperclip-tenant-manager
rules:
  - apiGroups: [""]
    resources: ["namespaces", "resourcequotas", "limitranges", "secrets", "serviceaccounts", "configmaps", "persistentvolumeclaims", "pods", "pods/log", "pods/exec"]
    verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["networkpolicies"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["roles", "rolebindings"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]
  - apiGroups: ["cilium.io"]
    resources: ["ciliumnetworkpolicies"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]
```

Apply it to a cluster with:

```bash
kubectl apply -f packages/adapters/kubernetes-execution/manifests/paperclip-tenant-manager-clusterrole.yaml
```

## Rule-by-rule rationale

### Core API group (`apiGroups: [""]`)

| Resource | Why the driver needs it |
|----------|------------------------|
| `namespaces` | Create and patch tenant namespaces (`paperclip-{companySlug}`). The driver reads the existing namespace to check for `paperclip.ai/managed-by=paperclip` before mutating — it will not touch namespaces it did not create. `watch` is used in M2 to track namespace deletion events. |
| `resourcequotas` | Apply `paperclip-tenant-quota` to each namespace. Must `patch` on re-provision (quota overrides from `cluster_tenant_policies`). |
| `limitranges` | Apply `paperclip-tenant-limits`. Must `patch` on billing tier changes. |
| `secrets` | (a) Create `paperclip-image-pull` (registry credentials per namespace). (b) In M2: create per-Job ephemeral Secrets that hold resolved `secret_ref` values; these carry an `OwnerReference` to the Job so Kubernetes GCs them automatically. |
| `serviceaccounts` | Create the `paperclip-agent` ServiceAccount in each namespace (`automountServiceAccountToken: false`). |
| `configmaps` | Reserved for M2: workspace-init config and adapter configuration injection via `ConfigMap` volumes. |
| `persistentvolumeclaims` | M2: create per-agent `PVC` (`agent-{agentSlug}-workspace`) for warm workspace storage. `watch` is needed to wait for the PVC to be bound before submitting the Job. |
| `pods` | M2: read pod status to determine Job phase; gate on pod `Ready` condition. |
| `pods/log` | M2: stream container logs from agent pods back to the Paperclip run log via `ctx.onLog`. |
| `pods/exec` | M2: reserved for workspace-init debug flows and operator diagnostics. Not used in M1. |

### Batch API group (`apiGroups: ["batch"]`)

| Resource | Why the driver needs it |
|----------|------------------------|
| `jobs` | M2: submit one `Job` per agent run. The driver needs `watch` to track the Job to completion and map terminal conditions to `AdapterExecutionResult` exit codes. `delete` is used for cancellation. |

This rule is present in the ClusterRole now so that M2 can begin scheduling runs without an RBAC update. In M1, the driver's `run()` method returns `NOT_YET_SUPPORTED` before any Job is submitted.

### Networking API group (`apiGroups: ["networking.k8s.io"]`)

| Resource | Why the driver needs it |
|----------|------------------------|
| `networkpolicies` | Apply three `NetworkPolicy` objects per namespace: `default-deny-ingress`, `default-deny-egress`, `paperclip-agent-egress`. Must `patch` on re-provision to update the FQDN allowlist or control-plane selector. `watch` is not required (policies are reconciled at `ensure-tenant` time). |

### RBAC API group (`apiGroups: ["rbac.authorization.k8s.io"]`)

| Resource | Why the driver needs it |
|----------|------------------------|
| `roles` | Reserved for M2: in-namespace `Role` objects for fine-grained per-job access control. |
| `rolebindings` | The driver creates a `RoleBinding` named `paperclip-driver` in each tenant namespace, binding the `paperclip-tenant-manager` ClusterRole to the driver ServiceAccount scoped to that namespace. This is required for the driver to have write access to namespaced resources after initial namespace creation. |

**Important:** The ability to create `RoleBindings` is a powerful permission. The driver is constrained to bind only the roles it already holds (the k8s API enforces that you cannot grant more than you have). The `paperclip-driver` identity should be protected: the ServiceAccount token must not be exposed outside the control plane.

### Cilium API group (`apiGroups: ["cilium.io"]`)

| Resource | Why the driver needs it |
|----------|------------------------|
| `ciliumnetworkpolicies` | When the cluster has the Cilium CNI, apply a `CiliumNetworkPolicy` alongside the vanilla NetworkPolicy. The CNP provides L7/FQDN egress filtering (see [security-model.md](./security-model.md#cilium-variant-fqdn-allowlist-auto-detected)). If Cilium is not present, this rule is harmless — the `cilium.io` API group simply does not exist. |

## Binding templates

### In-cluster topology

Paperclip server and agent workloads share the same cluster. The server pod's ServiceAccount in `paperclip-system` holds the driver identity.

```yaml
# Step 1: namespace for the Paperclip control plane
apiVersion: v1
kind: Namespace
metadata:
  name: paperclip-system
---
# Step 2: ServiceAccount for the driver
apiVersion: v1
kind: ServiceAccount
metadata:
  name: paperclip-driver
  namespace: paperclip-system
---
# Step 3: bind the ClusterRole cluster-wide
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: paperclip-driver
subjects:
  - kind: ServiceAccount
    name: paperclip-driver
    namespace: paperclip-system
roleRef:
  kind: ClusterRole
  name: paperclip-tenant-manager
  apiGroup: rbac.authorization.k8s.io
```

Apply:

```bash
kubectl apply -f paperclip-system-sa.yaml
```

The Paperclip server pod must run with `serviceAccountName: paperclip-driver`. The `@kubernetes/client-node` library will automatically use the in-cluster ServiceAccount token from `/var/run/secrets/kubernetes.io/serviceaccount/`.

When adding the cluster connection, use `--kind in-cluster` (no `--kubeconfig-secret`):

```bash
paperclipai cluster add \
  --label production \
  --kind in-cluster
```

### Cross-cluster topology

The Paperclip server runs outside the workload cluster. Access is via a stored kubeconfig whose embedded user must have the same permissions as the `paperclip-tenant-manager` ClusterRole.

The kubeconfig user identity is cluster-specific. Apply the ClusterRole and a `ClusterRoleBinding` on the **workload cluster** that binds the kubeconfig user:

```yaml
# Apply to the workload cluster (not the control-plane cluster)
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: paperclip-driver-external
subjects:
  - kind: User
    name: paperclip-driver   # must match the user in the kubeconfig
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: paperclip-tenant-manager
  apiGroup: rbac.authorization.k8s.io
```

```bash
# Apply to the workload cluster
kubectl apply -f paperclip-driver-external-crb.yaml \
  --kubeconfig /path/to/workload-cluster-admin.kubeconfig
```

The kubeconfig stored in the Paperclip secret provider must have a `users[].user` entry that matches the `subjects[].name` above. With a certificate-based kubeconfig, the CN in the client certificate is the username.

When adding the cluster connection:

```bash
paperclipai cluster add \
  --label workload-cluster-1 \
  --kind kubeconfig \
  --kubeconfig-secret vault:secret/data/paperclip/wc1-kubeconfig
```

**Note:** The RBAC rules must be applied to every cluster the kubeconfig user is expected to manage. If a single kubeconfig contains multiple contexts, apply the ClusterRole and ClusterRoleBinding to each cluster independently.

## Least-privilege notes

The ClusterRole is broader than M1 strictly requires because it is designed to serve M1 through M2 without an RBAC update. In M1 the driver only provisions namespaces; in M2 it will also schedule Jobs and stream pod logs.

If your security policy requires strict M1-only RBAC, you can create a narrower ClusterRole that omits `jobs`, `pods`, `pods/log`, `pods/exec`, `persistentvolumeclaims`, and `configmaps`. When M2 ships you will need to re-apply a wider role. This trade-off is yours to make as an operator.

## Related

- [Quickstart](./quickstart.md) — first-time cluster setup walkthrough
- [Security model](./security-model.md) — how each provisioned object enforces isolation
- [Multi-tenant onboarding](./multi-tenant-onboarding.md) — provisioning multiple tenants
- [Design spec §2.2](../superpowers/specs/2026-05-08-paperclip-cloud-adapter-design.md#22-pod-identity-zero-trust-by-default)

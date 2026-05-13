---
title: Kubernetes Execution — Multi-Tenant Onboarding
summary: Operator playbook for provisioning multiple company namespaces, customising per-tenant quotas, and resolving common edge cases
---

This playbook covers the full lifecycle of onboarding a company onto a Kubernetes cluster: verifying cluster prerequisites, optionally customising the per-tenant policy, running `ensure-tenant`, and verifying the result. The security model behind each provisioned object is described in [security-model.md](./security-model.md).

**M1 scope:** This playbook covers tenant namespace provisioning only. There is no web UI for these operations yet (M3). Agent execution lands in M2.

## Step 1 — Verify cluster prerequisites

Before provisioning any tenant, confirm the cluster is ready.

```bash
paperclipai cluster doctor <clusterId>
```

Check the output for:

| Check | Expected result |
|-------|----------------|
| API server reachable | `ok` |
| `paperclip-tenant-manager` ClusterRole exists | `ok` |
| Default StorageClass present | `ok` — note the StorageClass name for reference |
| Cilium detected | `ok` or `not detected` (informational only in M1) |

If `doctor` reports a missing ClusterRole, apply it:

```bash
kubectl apply -f packages/adapters/kubernetes-execution/manifests/paperclip-tenant-manager-clusterrole.yaml
```

For a from-scratch cluster setup including the ServiceAccount and ClusterRoleBinding, see [quickstart.md](./quickstart.md#first-time-cluster-setup).

## Step 2 — Optionally customise the per-tenant policy

By default, every tenant gets the [quota and limit-range defaults](./security-model.md#resourcequota-and-limitrange). If a company needs different resource caps (for example, a larger plan), upsert a row in `cluster_tenant_policies` before running `ensure-tenant`.

There is no CLI for this in M1. Use a direct database query or a DB migration script.

### cluster_tenant_policies row shape

```sql
INSERT INTO cluster_tenant_policies (
  id,
  cluster_connection_id,
  company_id,
  quota_json,
  limit_range_json,
  network_json,
  image_overrides_json,
  created_at,
  updated_at
) VALUES (
  gen_random_uuid(),
  '<clusterId>',
  '<companyId>',
  -- quota_json: override any of the default quota fields; null = use defaults
  '{
    "requestsCpu":    "32",
    "requestsMemory": "128Gi",
    "limitsCpu":      "128",
    "limitsMemory":   "512Gi",
    "requestsStorage":"500Gi",
    "countJobs":       200,
    "countPvcs":       100,
    "countSecrets":    400,
    "countConfigMaps": 400
  }'::jsonb,
  -- limit_range_json: override container default/request/max; null = use defaults
  '{
    "default":        { "cpu": "2",    "memory": "4Gi"  },
    "defaultRequest": { "cpu": "500m", "memory": "1Gi"  },
    "max":            { "cpu": "16",   "memory": "64Gi" },
    "pvcMaxStorage":  "50Gi"
  }'::jsonb,
  -- network_json: additional FQDN allowlist entries (Cilium only) and optional HTTP proxy
  '{
    "additionalAllowFqdns": ["npm.registry.example.com", "*.internal.example.com"],
    "httpProxyUrl": null
  }'::jsonb,
  -- image_overrides_json: swap runtime images per adapter type; null = use cluster defaults
  null,
  now(),
  now()
)
ON CONFLICT (cluster_connection_id, company_id) DO UPDATE
  SET quota_json           = EXCLUDED.quota_json,
      limit_range_json     = EXCLUDED.limit_range_json,
      network_json         = EXCLUDED.network_json,
      image_overrides_json = EXCLUDED.image_overrides_json,
      updated_at           = now();
```

All four JSON columns are nullable. A null value means "use the global default for that field". Individual keys within each JSON object are also optional — omitting a key leaves that specific default unchanged.

A CLI for managing tenant policies is planned for a future milestone. Until then, the SQL above is the canonical operator interface.

## Step 3 — Provision the tenant namespace

```bash
paperclipai cluster ensure-tenant <clusterId> <companyId>
```

Expected output:

```
Provisioned namespace paperclip-<companySlug> (cilium=false)
```

Or if Cilium is detected:

```
Provisioned namespace paperclip-<companySlug> (cilium=true)
```

`ensure-tenant` is idempotent. Running it again on an already-provisioned namespace is safe and will patch any drifted objects back to their desired state. The command reads the `cluster_tenant_policies` row (if it exists) before applying quota and LimitRange objects.

Objects created (in order):

1. `Namespace` with PSS labels and `paperclip.ai/*` metadata labels
2. `ServiceAccount paperclip-agent` (`automountServiceAccountToken: false`)
3. `RoleBinding paperclip-driver` (binds `ClusterRole/paperclip-tenant-manager` to the driver SA, scoped to this namespace)
4. `ResourceQuota paperclip-tenant-quota`
5. `LimitRange paperclip-tenant-limits`
6. `NetworkPolicy default-deny-ingress` and `default-deny-egress`
7. `NetworkPolicy paperclip-agent-egress`
8. `CiliumNetworkPolicy paperclip-agent-egress-l7` (only when `capabilities.cilium = true`)
9. `Secret paperclip-image-pull` (only when image registry credentials are configured)

## Step 4 — Verify the provisioned namespace

```bash
kubectl describe namespace paperclip-<companySlug>
```

Look for:

```
Labels:
  paperclip.ai/company-id=<uuid>
  paperclip.ai/company-slug=<slug>
  paperclip.ai/managed-by=paperclip
  pod-security.kubernetes.io/enforce=restricted
  pod-security.kubernetes.io/audit=restricted
  pod-security.kubernetes.io/warn=restricted
```

Verify all managed objects are present:

```bash
kubectl get sa,resourcequota,limitrange,networkpolicy \
  -n paperclip-<companySlug> \
  -l paperclip.ai/managed-by=paperclip
```

If Cilium is present, also check:

```bash
kubectl get ciliumnetworkpolicy -n paperclip-<companySlug>
```

## Provisioning multiple companies

Loop over company IDs from your database or source of truth:

```bash
CLUSTER_ID="<clusterId>"

for COMPANY_ID in \
  "uuid-company-a" \
  "uuid-company-b" \
  "uuid-company-c"; do
  echo "Provisioning $COMPANY_ID..."
  paperclipai cluster ensure-tenant "$CLUSTER_ID" "$COMPANY_ID"
done
```

`ensure-tenant` is safe to run in parallel; each company operates on a separate namespace.

## Common edge cases

### Quota exhaustion

When an agent run (M2) cannot schedule because the tenant has hit a quota limit, the Kubernetes API returns a `403 Forbidden` with `reason: Forbidden` and a message referencing the quota object. In M1, this surfaces at `ensure-tenant` time only if the quota parameters themselves are invalid (e.g. a LimitRange `max` that is smaller than `default`).

To inspect current quota usage for a namespace:

```bash
kubectl describe resourcequota paperclip-tenant-quota -n paperclip-<companySlug>
```

To increase quotas, upsert the `cluster_tenant_policies` row with larger values and re-run `ensure-tenant`.

### DNS resolution issues

If a pod cannot resolve external hostnames, verify the NetworkPolicy allows DNS egress to `kube-system/kube-dns`:

```bash
kubectl get networkpolicy paperclip-agent-egress \
  -n paperclip-<companySlug> \
  -o yaml
```

Look for the DNS egress rule on port 53. If it is missing (e.g. the namespace was provisioned against an older driver), re-run `ensure-tenant` to patch it in.

Check that CoreDNS is running:

```bash
kubectl get pods -n kube-system -l k8s-app=kube-dns
```

### Image pull failures

Three distinct failure modes:

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `ImagePullBackOff`, event: `no credentials` | No `imagePullSecret` in the namespace | Ensure the cluster connection has an `imageRegistry` configured and re-run `ensure-tenant` |
| `ImagePullBackOff`, event: `401 Unauthorized` | Wrong credentials | Rotate the secret in the secret provider and re-run `ensure-tenant` |
| `ImagePullBackOff`, event: `i/o timeout` | Registry unreachable | Check the NetworkPolicy allows egress to the registry FQDN on port 443; on Cilium, add the FQDN to `network_json.additionalAllowFqdns` in `cluster_tenant_policies` |

### Privileged pod admission rejection

To confirm that PSS Restricted is active and blocking privileged pods:

```bash
kubectl run test-privileged \
  --image=nginx \
  --overrides='{"spec":{"containers":[{"name":"test-privileged","image":"nginx","securityContext":{"privileged":true}}]}}' \
  -n paperclip-<companySlug>
```

Expected output:

```
Error from server (Forbidden): pods "test-privileged" is forbidden:
violates PodSecurity "restricted:latest": ...
```

This rejection proves the PodSecurityAdmission webhook is active on the namespace. If the pod is admitted instead, confirm the PSS labels are present on the namespace with `kubectl describe namespace`.

### Namespace name collision

If two companies have the same `companySlug`, the driver uses the fallback name `paperclip-{slug}-{base36hash}`. The `paperclip.ai/company-id` label is always the canonical identifier. To see which namespace belongs to a given company:

```bash
kubectl get ns -l paperclip.ai/company-id=<companyId>
```

## Related

- [Quickstart](./quickstart.md) — initial cluster setup and first `ensure-tenant`
- [Security model](./security-model.md) — what each provisioned object does and why
- [Cluster RBAC](./cluster-rbac.md) — driver ClusterRole reference
- [Design spec §2.1](../superpowers/specs/2026-05-08-paperclip-cloud-adapter-design.md#21-tenant-boundary-namespace-per-company)
- [M1 plan](../superpowers/plans/2026-05-08-paperclip-cloud-adapter-m1-plan.md)

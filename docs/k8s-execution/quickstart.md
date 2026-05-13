---
title: Kubernetes Execution — Quickstart
summary: First-time setup guide for operators connecting a Kubernetes cluster to Paperclip and provisioning a tenant namespace
---

This guide walks an operator through connecting a Kubernetes cluster to a Paperclip M1 deployment and provisioning the first tenant namespace. By the end you will have a verified cluster connection and a namespace that passes `kubectl describe namespace` — ready for agent execution when M2 ships.

**M1 scope:** This release delivers tenant namespace provisioning only. Agent execution (running adapter pods) is an M2 feature. See [What's not in M1](#whats-not-in-m1) for the full boundary.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| `kubectl` | 1.28+ | Must be on `$PATH` |
| `kind` | 0.22+ | Only if using a local kind cluster |
| Docker | 24+ | Required to run kind |
| Paperclip server | M1 build | `PAPERCLIP_K8S_DRIVER=true` env var must be set |
| `paperclipai` CLI | M1 build | `pnpm paperclipai --version` should print a version |

A PostgreSQL database with the M1 migrations applied (`packages/db/src/migrations/0082_cluster_connections.sql`) is required before any cluster commands work.

## First-time cluster setup

### 1. Start a kind cluster (if you don't have one)

```bash
kind create cluster --name paperclip-dev
kubectl cluster-info --context kind-paperclip-dev
```

For a production cluster, ensure it has:
- A default `StorageClass` (used for agent PVCs in M2)
- `NetworkPolicy` enforcement (Calico, Cilium, or compatible CNI)

### 2. Apply the reference ClusterRole

The Paperclip driver needs a `ClusterRole` that allows it to manage tenant namespaces and the objects inside them.

```bash
kubectl apply -f packages/adapters/kubernetes-execution/manifests/paperclip-tenant-manager-clusterrole.yaml
```

Verify it was created:

```bash
kubectl get clusterrole paperclip-tenant-manager
```

### 3. Create the driver ServiceAccount and bind the ClusterRole

For an **in-cluster** topology (Paperclip server running inside the same cluster), create the ServiceAccount in the `paperclip-system` namespace:

```yaml
# paperclip-system-sa.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: paperclip-system
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: paperclip-driver
  namespace: paperclip-system
---
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

```bash
kubectl apply -f paperclip-system-sa.yaml
```

For a **cross-cluster** topology (Paperclip server is elsewhere), the kubeconfig user must already be bound to the same `ClusterRole` on the workload cluster. See [cluster-rbac.md](./cluster-rbac.md) for details on both topologies.

### 4. Store the kubeconfig as a Paperclip secret

Paperclip resolves cluster credentials through its secret provider abstraction. The `kubeconfig_secret_ref` field on a `cluster_connections` row holds a `{ provider, name }` pair. Supported providers in M1:

| Provider string | Where the secret lives |
|-----------------|----------------------|
| `env` | Environment variable (e.g. `env:KUBECONFIG_KIND`) |
| `aws_secrets` | AWS Secrets Manager secret ARN or name |
| `gcp_secret` | GCP Secret Manager resource path |
| `vault` | HashiCorp Vault path (`vault:secret/data/paperclip/kind-cfg`) |

For a local kind cluster, the simplest path is the `env` provider. Export the kubeconfig and set an environment variable on the Paperclip server:

```bash
kind get kubeconfig --name paperclip-dev > /tmp/kind-cfg.yaml
export KUBECONFIG_KIND=$(cat /tmp/kind-cfg.yaml)
```

Then reference it as `env:KUBECONFIG_KIND` in the `--kubeconfig-secret` flag below.

> **Note:** `local_encrypted` (a Paperclip-managed encrypted store) is planned for M2. Until then, use one of the providers listed above.

## Add a cluster connection

```bash
paperclipai cluster add \
  --label kind \
  --kind kubeconfig \
  --kubeconfig-secret env:KUBECONFIG_KIND
```

The command probes the cluster for capabilities (Cilium presence, default StorageClass, node architectures) and writes a row to `cluster_connections`. The printed `id` is the `<clusterId>` used in subsequent commands.

Additional flags:

| Flag | Purpose |
|------|---------|
| `--paperclip-public-url <url>` | Override the Paperclip server URL agents use to call back (cross-cluster only) |
| `--image-registry <url>` | Override the image registry for agent runtime images |

## Verify the connection

```bash
# Check reachability, RBAC, and cluster capabilities
paperclipai cluster doctor <id>

# List all registered cluster connections
paperclipai cluster list
```

`cluster doctor` checks:
- API server reachability via the stored kubeconfig
- `paperclip-tenant-manager` ClusterRole exists
- Default StorageClass is present
- Cilium CRD presence (informational)

## Provision a tenant for a company

```bash
paperclipai cluster ensure-tenant <clusterId> <companyId>
```

Expected output:

```
Provisioned namespace paperclip-<companySlug> (cilium=false)
```

Or, if Cilium is present on the cluster:

```
Provisioned namespace paperclip-<companySlug> (cilium=true)
```

`ensure-tenant` is **idempotent** — running it twice is safe and brings any drifted objects back to the desired state. The driver refuses to touch a namespace that lacks the `paperclip.ai/managed-by=paperclip` label.

## Verify the namespace with kubectl

```bash
kubectl get ns,sa,resourcequota,limitrange,networkpolicy \
  -l paperclip.ai/managed-by=paperclip
```

You should see:
- `Namespace` named `paperclip-<companySlug>`
- `ServiceAccount` named `paperclip-agent`
- `ResourceQuota` named `paperclip-tenant-quota`
- `LimitRange` named `paperclip-tenant-limits`
- `NetworkPolicy` objects `default-deny-ingress`, `default-deny-egress`, `paperclip-agent-egress`

```bash
kubectl describe namespace paperclip-<companySlug>
```

Check that the PSS labels are present:

```
Labels: pod-security.kubernetes.io/enforce=restricted
        pod-security.kubernetes.io/audit=restricted
        pod-security.kubernetes.io/warn=restricted
        paperclip.ai/managed-by=paperclip
        paperclip.ai/company-id=<uuid>
```

## Run your first agent

After a cluster is bound to a tenant, run an agent on it:

```bash
paperclipai agent register --company acme --adapter claude_local \
  --execution-target kubernetes:prod
paperclipai agent run --agent <id> --prompt "say hi"
```

Expected: streamed logs from the agent pod ending with the assistant text.

If logs appear empty, check that:
1. The `agent-runtime-claude` image is reachable from the cluster (cosign verify the image, see [security-model.md](./security-model.md)).
2. The bootstrap-token exchange route is reachable: `curl https://<paperclip-public-url>/api/agent-auth/exchange -d '{}'` should return `400 missing_token` (proves it's wired).
3. `PAPERCLIP_RUN_JWT_SECRET` is set on the server (otherwise the routes are mounted but reject every request).

For the full walkthrough of what happens between `agent run` and assistant text reaching your terminal, see [agent-execution-flow.md](./agent-execution-flow.md). For failure-mode triage, see [troubleshooting.md](./troubleshooting.md).

## What's not in M1

| Feature | Milestone |
|---------|-----------|
| Agent execution (running adapter pods as Kubernetes Jobs) | M2 |
| Web UI for cluster management and health | M3 |
| Per-company BYO cluster (one cluster connection per company) | V2 |
| VolumeSnapshot-based agent workspace cloning | V2 |
| `local_encrypted` secret provider | M2 |
| `paperclipai cluster purge` (namespace teardown) | M2 |

For the full V1/V2 scope split see the [design spec](../superpowers/specs/2026-05-08-paperclip-cloud-adapter-design.md#non-goals-v1).

## Next steps

- [Security model](./security-model.md) — understand the isolation primitives applied to each namespace
- [Multi-tenant onboarding](./multi-tenant-onboarding.md) — operator playbook for provisioning multiple companies
- [Cluster RBAC](./cluster-rbac.md) — full ClusterRole reference and binding templates

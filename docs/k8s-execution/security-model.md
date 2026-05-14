---
title: Kubernetes Execution — Security Model
summary: Isolation primitives applied to every tenant namespace — NetworkPolicy, PodSecurity, RBAC, ResourceQuota, and compliance posture
---

Every company that runs agents on a Kubernetes cluster gets an isolated namespace with a layered set of controls. This document describes each layer, why it exists, and how to verify it. The spec section that defines these primitives is [§2 of the design spec](../superpowers/specs/2026-05-08-paperclip-cloud-adapter-design.md#2-tenancy-isolation--cluster-connection).

**M1 scope:** These controls are provisioned by `cluster ensure-tenant`. Agent pods that enforce them (PodSecurity Restricted, NetworkPolicy enforcement during actual runs) are an M2 deliverable. The namespace is fully hardened at provision time; the hardening is exercised at run time.

## Tenancy boundary: one Namespace per company

Every Paperclip company maps to exactly one namespace per cluster connection, named `paperclip-{companySlug}`. This is the primary isolation boundary: Kubernetes RBAC, ResourceQuota, NetworkPolicy, and PodSecurityAdmission all attach at the namespace level.

**Naming rules** (from [spec §2.1](../superpowers/specs/2026-05-08-paperclip-cloud-adapter-design.md#21-tenant-boundary-namespace-per-company)):
- Primary: `paperclip-{companySlug}` (companySlug truncated to 53 chars so the total stays ≤ 63)
- Fallback: `paperclip-{companySlug}-{base36(blake3(companyId))[:8]}` on DNS-1123 overflow or slug collision

The immutable machine identifier is the `paperclip.ai/company-id=<uuid>` label on the Namespace object, not the namespace name.

The driver refuses to manage any namespace that does not carry `paperclip.ai/managed-by=paperclip`. This prevents accidental mutation of pre-existing namespaces.

## Pod identity: zero-trust by default

Each tenant namespace contains a `ServiceAccount` named `paperclip-agent` with:

```yaml
automountServiceAccountToken: false
```

This ServiceAccount has **no RBAC bindings** by default. A pod running as `paperclip-agent` cannot call the Kubernetes API at all. The driver's own identity (the `paperclip-driver` ServiceAccount in `paperclip-system`) is separate and holds the `ClusterRole` described in [cluster-rbac.md](./cluster-rbac.md).

Disabling `automountServiceAccountToken` removes the projected token from the pod filesystem, eliminating a common privilege escalation path even if the service account later gains bindings.

## NetworkPolicy: default-deny + allowlist

Three NetworkPolicy objects are applied to every tenant namespace.

### default-deny-ingress

```yaml
podSelector: {}
policyTypes: [Ingress]
```

Blocks all ingress to every pod in the namespace. Agent pods do not accept inbound connections.

### default-deny-egress

```yaml
podSelector: {}
policyTypes: [Egress]
```

Blocks all egress by default. Only pods that match the `paperclip-agent-egress` allowlist policy can make outbound connections.

### paperclip-agent-egress

Applied only to pods labeled `paperclip.ai/role: agent-runtime`. Three egress rules, in order:

**1. Cluster DNS**

```yaml
to:
  - namespaceSelector:
      matchLabels: { kubernetes.io/metadata.name: kube-system }
    podSelector:
      matchLabels: { k8s-app: kube-dns }
ports: [{ port: 53, protocol: UDP }, { port: 53, protocol: TCP }]
```

Agents need name resolution to reach the Paperclip server and external APIs.

**2. In-cluster Paperclip server** (in-cluster topology only)

```yaml
to:
  - namespaceSelector:
      matchLabels: { paperclip.ai/role: control-plane }
    podSelector:
      matchLabels: { app.kubernetes.io/name: paperclip-server }
ports: [{ port: 443, protocol: TCP }, { port: 3102, protocol: TCP }]
```

Agents call back to the Paperclip server to exchange the bootstrap token for a run JWT. This rule is omitted for cross-cluster topologies where the server is not in the same cluster.

**3. Internet egress with internal ranges denied**

```yaml
to:
  - ipBlock:
      cidr: 0.0.0.0/0
      except:
        - 10.0.0.0/8
        - 172.16.0.0/12
        - 192.168.0.0/16
        - 169.254.0.0/16    # link-local — cloud metadata service
        - 100.64.0.0/10     # CGNAT
  - ipBlock:
      cidr: ::/0
      except:
        - fd00::/8          # IPv6 ULA
ports: [{ port: 443, protocol: TCP }]
```

**Why each block matters:**

| CIDR | What it blocks | Why it matters |
|------|----------------|----------------|
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | RFC 1918 private ranges | Cluster-internal databases, caches, other services |
| `169.254.0.0/16` | Link-local (incl. `169.254.169.254`) | **Cloud metadata service** — this is the primary SSRF target on AWS/GCP/Azure. A compromised pod that can reach the metadata service can obtain instance credentials and escape the tenant boundary |
| `100.64.0.0/10` | CGNAT / shared address space | Often used by cloud providers for internal routing; blocks a secondary metadata path on some platforms |
| `fd00::/8` | IPv6 ULA | Internal IPv6 ranges; same threat model as RFC 1918. Must be in a separate `ipBlock` entry because the Kubernetes API rejects IPv6 ranges inside an IPv4 cidr |

The IPv4 and IPv6 deny blocks are intentionally separate `ipBlock` entries. The Kubernetes NetworkPolicy API requires each `except` entry to be a strict subset of its parent `cidr`; mixing IPv6 ranges inside `0.0.0.0/0` is rejected with a 422 error.

## Cilium variant: FQDN allowlist (auto-detected)

When `probeClusterCapabilities` detects the `cilium.io/v2` API group, the driver also applies a `CiliumNetworkPolicy` alongside the vanilla NetworkPolicy. The vanilla policy stays as defense-in-depth.

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: paperclip-agent-egress-l7
spec:
  endpointSelector:
    matchLabels: { paperclip.ai/role: agent-runtime }
  egress:
    - toFQDNs:
        - matchPattern: "*.anthropic.com"
        - matchPattern: "api.openai.com"
        - matchPattern: "*.googleapis.com"
        - matchPattern: "github.com"
        - matchPattern: "*.github.com"
        - matchPattern: "gitlab.com"
      toPorts:
        - ports: [{ port: "443", protocol: TCP }]
    - toEndpoints:
        - matchLabels: { paperclip.ai/role: control-plane }
      toPorts:
        - ports: [{ port: "443", protocol: TCP }]
```

The FQDN list is composed from two sources:
- `adapter.networkRequirements.allowFqdns` (declared per adapter type in `ServerAdapterModule`)
- `cluster_tenant_policies.network_json.additionalAllowFqdns` (per-tenant override, described in [multi-tenant-onboarding.md](./multi-tenant-onboarding.md))

Cilium detection happens automatically at `cluster add` time. Re-run `cluster doctor <id>` after installing Cilium to update the stored capabilities; then re-run `cluster ensure-tenant` to apply the CNP.

## PodSecurity Restricted

The namespace is labeled at provision time:

```yaml
pod-security.kubernetes.io/enforce: restricted
pod-security.kubernetes.io/audit:   restricted
pod-security.kubernetes.io/warn:    restricted
```

Any pod admitted to the namespace must conform to the `restricted` PodSecurity Standard. Agent pods (M2) are built to satisfy it:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
  seccompProfile: { type: RuntimeDefault }
containers:
  - securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities: { drop: [ALL] }
```

`readOnlyRootFilesystem: true` is enforced. Writable paths are:
- `/workspace` — agent `PersistentVolumeClaim` (M2)
- `/tmp` — `emptyDir` volume capped at 1 Gi (M2)

An attempt to `kubectl run` a privileged pod into a Paperclip namespace will be rejected by the admission controller — this is the expected behavior and confirms PSS is working. See [multi-tenant-onboarding.md](./multi-tenant-onboarding.md#common-edge-cases) for how to verify this.

## ResourceQuota and LimitRange

Default values (can be overridden per tenant via `cluster_tenant_policies` — see [multi-tenant-onboarding.md](./multi-tenant-onboarding.md)):

### ResourceQuota `paperclip-tenant-quota`

```yaml
hard:
  requests.cpu:                 "16"
  requests.memory:              "64Gi"
  limits.cpu:                   "64"
  limits.memory:                "256Gi"
  requests.storage:             "200Gi"
  count/jobs.batch:             "100"
  count/persistentvolumeclaims: "50"
  count/secrets:                "200"
  count/configmaps:             "200"
```

### LimitRange `paperclip-tenant-limits`

```yaml
limits:
  - type: Container
    default:        { cpu: "1",    memory: "2Gi" }
    defaultRequest: { cpu: "250m", memory: "512Mi" }
    max:            { cpu: "8",    memory: "32Gi" }
  - type: PersistentVolumeClaim
    max: { storage: "20Gi" }
```

The LimitRange ensures that pods without explicit resource requests/limits still get sensible defaults and cannot consume unbounded resources. Without it, a misconfigured pod could exhaust node capacity and starve other tenants.

## Image pull secret model

If the cluster connection has an associated image registry and the `imagePullDockerConfigJson` is resolved at provision time, the driver creates a `Secret` of type `kubernetes.io/dockerconfigjson` in the tenant namespace:

```
Secret name: paperclip-image-pull
Secret type: kubernetes.io/dockerconfigjson
```

This secret is referenced by agent pod specs (M2) as an `imagePullSecret`. Credentials are per-namespace and are not shared across tenants. The secret value is resolved from the Paperclip secret provider at `ensure-tenant` time.

## Secret-resolver M1 gap

The secret provider abstraction supports `aws_secrets`, `gcp_secret`, `vault`, and `env` in M1. The `local_encrypted` provider (Paperclip-managed encrypted store) is planned for M2.

Operators running a self-hosted Paperclip instance without access to a cloud secret manager should use `env:<VAR_NAME>` for the kubeconfig secret during M1.

## Compliance bookkeeping

The M1 provisioning pipeline is aligned with:

- **NSA/CISA Kubernetes Hardening Guidance** — Restricted PSS, NetworkPolicy default-deny, no privilege escalation, no host network/PID/IPC, drop ALL capabilities, RuntimeDefault seccomp
- **CIS Kubernetes Benchmark** — namespace isolation, ResourceQuota enforcement, no automounted ServiceAccount tokens

The CI release pipeline runs `kube-audit-kit` and `polaris` against a freshly provisioned tenant namespace on every build. PSS Restricted violations or NSA Hardening regressions block the release.

## Related

- [Quickstart](./quickstart.md) — set up a cluster connection and run `ensure-tenant`
- [Cluster RBAC](./cluster-rbac.md) — the driver ClusterRole and binding templates
- [Multi-tenant onboarding](./multi-tenant-onboarding.md) — playbook for provisioning multiple companies and handling edge cases
- [Design spec §2](../superpowers/specs/2026-05-08-paperclip-cloud-adapter-design.md#2-tenancy-isolation--cluster-connection)

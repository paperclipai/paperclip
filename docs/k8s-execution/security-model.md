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

## Run-JWT lifecycle (M2)

Agent containers cannot speak Kubernetes — they have no projected ServiceAccount token (see [Pod identity](#pod-identity-zero-trust-by-default)) and the agent ServiceAccount has no RBAC. To call back to the Paperclip server they use a two-step token exchange:

1. **Bootstrap token mint.** The driver calls `bootstrapTokensService` (`server/src/services/bootstrap-tokens.ts`) to mint a single-use, short-lived token bound to `(agentId, companyId, runId)`. The token is sealed into the per-Job Secret as `BOOTSTRAP_TOKEN` before the Job is created.
2. **Exchange.** Inside the pod, `paperclip-agent-shim` sends `POST /api/agent-auth/exchange` with the bootstrap token. The server validates one-time use, atomically marks the token consumed, and returns a **run JWT** signed with `PAPERCLIP_RUN_JWT_SECRET` (`server/src/services/run-jwt.ts`).
3. **Run JWT.** The run JWT carries `runId`, `agentId`, `companyId`, and the Job UID. It expires after the run's `activeDeadlineSeconds` ceiling. Every subsequent agent → server call (`POST /api/runs/:runId/events`, `POST /api/workspace/git-credentials`) presents the run JWT and the server validates the claims against the live run.

If `PAPERCLIP_RUN_JWT_SECRET` is unset on the server, the callback routes are skipped during app boot. The driver still mints bootstrap tokens, but every exchange request is rejected — verify the env var is set if agents log `401 invalid_token` during bootstrap.

## TokenReview disposition (V1)

The full Kubernetes-native `TokenReview` flow (where the server validates a projected ServiceAccount token straight from the cluster's API) is **deferred to V2**. M2 ships the bootstrap-token + run-JWT model above. Trade-off:

- **What we lose:** the run JWT is signed by the Paperclip server, not by the cluster's API server, so revocation is per-tenant policy (rotate `PAPERCLIP_RUN_JWT_SECRET`) rather than per-Pod TokenRequest revocation.
- **What we keep:** bootstrap tokens are single-use and short-lived; run JWTs are scoped to `(runId, agentId, companyId, jobUid)` so a stolen JWT cannot be replayed against a different run. Cross-cluster TokenReview tracking lives in [ROADMAP.md](../../ROADMAP.md) under M3 (Risk #5).

## Per-Job Secret with OwnerReferences

Run-time credentials (bootstrap token, redacted adapter env, optional git credentials) are sealed into a per-Job `Secret` of type `Opaque`. The driver's two-phase commit:

1. **Create Secret first.** `POST /api/v1/namespaces/<ns>/secrets` with the Secret body but no owner. The Secret is mounted as a read-only `secret` volume on the Job's pod template.
2. **Create Job.** `POST /apis/batch/v1/namespaces/<ns>/jobs` with the Pod template that references the Secret by name.
3. **Patch ownerReferences onto the Secret.** A `kubectl patch` equivalent rewrites the Secret's `metadata.ownerReferences` to point at the Job UID returned in step 2.

After step 3, when the Job's `ttlSecondsAfterFinished` expires, Kubernetes garbage-collects the Job and cascades the deletion to the Secret. There is no manual cleanup path for orphaned Secrets.

**Why not CSI Secrets Store?** CSI Secrets Store would inject credentials directly from a cloud secret manager into the pod, but:
- It requires the CSI driver be installed on every workload cluster (operator burden in a BYO-cluster product).
- It doesn't support the "credential exists only for the lifetime of one Job" model — secrets are per-`SecretProviderClass`, not per-Job.
- It cannot redact adapter env at materialization time, which is a hard requirement (see `packages/adapters/kubernetes-execution/src/redaction.ts`).

The two-phase commit is V1's shippable answer. CSI Secrets Store is on the roadmap for M3+ as an opt-in alternative.

## Secret resolver providers

The secret-resolver contract (`provider`, `name` → secret value) ships in M2 with the following providers:

| Provider | Wired in | Use case |
|----------|----------|----------|
| `env` | M1 | Read from process env. Lab and self-hosted setups. |
| `aws_secrets` | M1 | AWS Secrets Manager ARN or secret name. |
| `gcp_secret` | M1 | GCP Secret Manager resource path. |
| `vault` | M1 | HashiCorp Vault path. |
| `local_encrypted` | M1 | Paperclip-managed encrypted store, server local. |
| `aws_secrets_manager` | **M3** | Higher-level AWS provider with caching + IAM-role assumption. |
| `gcp_secret_manager` | **M3** | Higher-level GCP provider with workload-identity binding. |

M2 does not change the M1 provider list. The contract is stable; M3 adds higher-level providers without breaking existing rows.

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

## Git credentials in V1

V1 issues git credentials by resolving a per-company secret stored in
`company_secrets` and exposing it to the workspace-init container as a
`{username, password}` pair via the `/api/workspace/git-credentials` endpoint.

### Trust model

- The secret is owned by the company. Operators set it via `paperclip cluster set-git-credentials`.
- The secret is decrypted only on the server — the agent's pod never sees the wrapping ciphertext, only the resolved `{username, password}` JSON.
- The `/api/workspace/git-credentials` route requires a valid run-JWT (minted from a one-shot bootstrap token); the agent cannot exchange a JWT for credentials belonging to a different company.
- The route logs `repoUrl` for audit but does not gate on it. Any clone path the workspace-init opens uses the same credential pair.

### Limitations

- **One credential per company.** Tenants with multiple repos pointing at different orgs/hosts must use a single PAT broad enough to cover all of them, OR pick the most-restrictive shared PAT.
- **TTL is informational.** The exposed `expiresAt` is `now + 1h`, but the underlying `companySecret` is long-lived. The contract is stable so V2 (GitHub App installation tokens) can swap in a real TTL transparently.
- **No per-repo scoping.** A compromised PAT exposes every repo it has access to. Operators who need scoping must wait for V2 or use deploy keys with a separate `companySecret` per repo.

### V2 plan

V2 replaces the static PAT with a GitHub App installation token minted on-demand for the specific repo the agent is about to clone. The `/api/workspace/git-credentials` contract stays unchanged.

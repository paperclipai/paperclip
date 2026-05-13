# Paperclip Cloud Adapter — Multi-Tenant Kubernetes Execution

**Date:** 2026-05-08
**Status:** Spec — pending implementation plan
**Owner:** Jannes Stubbemann (brainstorming session)

---

## Executive Summary

Add Kubernetes as a first-class execution target for Paperclip agent runs, with multi-tenant isolation as a design property of the orchestrator (not bolted on later). Every existing adapter (`claude_local`, `codex_local`, `gemini_local`, `opencode_local`, `acpx_local`, `pi_local`, `hermes_local`) gains the ability to run inside a Kubernetes pod by selecting a `kubernetes` execution target — no per-adapter rewrites. Tenancy is enforced via namespace-per-company with the standard k8s-native isolation primitives (RBAC, ResourceQuota, NetworkPolicy, PodSecurity Restricted, per-namespace image pull credentials, ephemeral per-Job Secrets). Each agent gets a persistent `PersistentVolumeClaim` for warm workspaces; each run is an ephemeral `Job`. The orchestrator runs as library code inside the Paperclip server using `@kubernetes/client-node` — no separate operator binary, no CRDs, in V1.

Cluster topology is hybrid by design: the same code path serves an in-cluster Paperclip (workloads in adjacent namespaces) and a cross-cluster Paperclip (control plane elsewhere; workload cluster reached via stored kubeconfig). Cross-cluster auth reuses the bootstrap-token → run-JWT exchange pattern already specified for the Cursor Cloud adapter.

The Helm chart for the Paperclip control plane itself is **out of scope for this spec** — it's tracked separately and gated to ship after the cloud adapter lands.

---

## Goals

1. Run Paperclip agents on Kubernetes with strong tenant isolation suitable for multi-tenant SaaS.
2. Keep adapters unchanged — extension via the existing `executionTarget` seam, not new adapter types.
3. Single shared orchestration package; no per-adapter k8s code.
4. Match k8s-native idioms: `Job`, `PVC`, `Namespace`, `NetworkPolicy`, `ResourceQuota`, `LimitRange`, `PodSecurity` Restricted.
5. Reuse the bootstrap-token → run-JWT auth flow already shipped for the Cursor Cloud adapter — one server-side route, two callers.
6. Support both same-cluster and cross-cluster topologies behind one configuration model.
7. Security baseline aligned with NSA/CISA Kubernetes Hardening and CIS Kubernetes Benchmark.
8. Operator-debuggable via standard tools: `kubectl get jobs -n paperclip-acme-corp`, audit log entries, structured run-level events.

## Non-Goals (V1)

- Helm chart for the Paperclip control plane (separate spec, gated to follow).
- Per-company BYO cluster (one or more cluster connections at the *instance* level only).
- Pod-per-agent mode (StatefulSet + KEDA scale-to-zero) — designed-for, not built.
- External Secrets Operator integration — abstraction in place, no driver in V1.
- VolumeSnapshot-based agent cloning.
- `PaperclipAgentRun` CRD + reconciliation operator — not built unless reconciliation needs justify it.
- Fine-grained image attestation enforcement (we sign; we don't enforce verify in admission).
- IPv6 dual-stack pods.

---

## Architectural Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Add a new `kubernetes` kind to the existing `AdapterExecutionTarget` rather than creating a `kubernetes_pod` adapter. | Every adapter inherits k8s execution for free. Single shared orchestrator. Matches the pattern already used for `ssh` and `sandbox`. |
| 2 | Tenant boundary = `Namespace` per Paperclip company. | K8s-native isolation primitive. RBAC, ResourceQuota, NetworkPolicy, PSS labels all attach naturally. Free, mature, widely understood. |
| 3 | Workload granularity inside a tenant = pod-per-run as a `Job`, with PVC-per-agent for warm workspaces. | Strict isolation per run; PVC reuse keeps workspaces warm without coupling pod lifetimes. Pod-per-company was rejected (poor isolation, doesn't actually save cluster cost). |
| 4 | Hybrid topology with bootstrap-token auth. | One auth path serves SaaS (Paperclip on control-plane cluster, agents on workload cluster) and self-hosted single-cluster. Reuses cursor-cloud's exchange route. |
| 5 | Imperative orchestration via `@kubernetes/client-node` from the Paperclip server. No CRDs, no operator binary. | Smallest moving parts. Reconciliation is delegated to k8s primitives (Job `backoffLimit`, `TTLAfterFinished`, `OwnerReferences`, `PodFailurePolicy`). Easy to test against `kind`. |
| 6 | Workspace bootstrap = init container running the existing Paperclip workspace strategy. | Reuses existing strategy logic; agents see identical filesystem layout to local. Cold = full clone, warm = fetch+reset. |
| 7 | Namespace naming = `paperclip-{companySlug}` (operator-friendly), with `-{shortHash}` fallback on collision or DNS-1123 overflow. | Slug already exists in Paperclip (URL `:companyPrefix`). `kubectl` users get human-readable names. Immutable `paperclip.ai/company-id` label is the canonical machine identifier. |
| 8 | The platform-module surface is extended (in spec, not yet existing) with `registerExecutionTargetDriver()` to keep parity with `registerAgentAdapter()` / `registerStorageProvider()`. The k8s driver is the first registered driver. | Keeps the door open for third-party drivers (Nomad, ECS, Modal-style) without core changes later. Honors the user's "leverage the plugin system" intent within the actual extension model. |

---

## 1. Architecture & Code Layout

### 1.1 The seam

The codebase already has `AdapterExecutionTarget` in `packages/adapter-utils/src/execution-target.ts` (today: `local`, `ssh`, `sandbox`). Add one new kind:

```ts
type AdapterExecutionTarget =
  | LocalExecutionTarget
  | SshExecutionTarget
  | SandboxExecutionTarget
  | KubernetesExecutionTarget;        // NEW

interface KubernetesExecutionTarget {
  kind: "kubernetes";
  clusterConnectionId: string;
  namespaceOverride?: string;          // rare; defaults to companySlug-derived name
  imageOverride?: string;              // gated by per-cluster policy
  resources?: {                        // overrides LimitRange defaults
    requests?: { cpu?: string; memory?: string };
    limits?:   { cpu?: string; memory?: string };
  };
  storage?: {
    sizeGi?: number;                   // defaults to per-tenant policy
    storageClass?: string;             // overrides ClusterConnection default
  };
  envOverrides?: Record<string, string>;  // resolved as secret_refs at materialization
}
```

### 1.2 Code layout

```
packages/
  adapters/
    kubernetes-execution/                # NEW package: @paperclipai/execution-target-kubernetes
      package.json
      tsconfig.json
      src/
        index.ts                         # createKubernetesExecutionDriver()
        driver.ts                        # one Job per run, streams stdout, returns AdapterExecutionResult
        client.ts                        # @kubernetes/client-node thin wrapper
        types.ts
        orchestrator/
          job.ts                         # Job spec builder
          pvc.ts                         # PVC spec builder
          secret.ts                      # ephemeral per-Job Secret materializer (interface + native impl)
          namespace.ts                   # company → namespace ensure-and-tag
          rbac.ts                        # ServiceAccount + Role + RoleBinding for the namespace
          network-policy.ts              # default-deny + allowlist (vanilla + Cilium variants)
          resource-quota.ts              # ResourceQuota + LimitRange from tenant policy
          pod-security.ts                # restricted PSS context defaults
          log-stream.ts                  # k8s log watch → onLog
          event-watch.ts                 # Job/Pod Event watch → run log "[k8s]" prefix
        bootstrap/
          init-container.ts              # workspace-init container spec
          callback-token.ts              # bootstrap-token issuance (calls server)
        redaction.ts                     # secret value redaction layer
      test/
        unit/                            # spec builders, RBAC, NetworkPolicy, redaction
        integration/                     # kind/k3d cluster, full lifecycle

  adapter-utils/
    src/
      execution-target.ts                # MODIFIED — add KubernetesExecutionTarget kind

server/
  src/
    adapters/
      execution-target-registry.ts       # NEW — platform-module registry for drivers
      execution-targets/
        kubernetes.ts                    # registers @paperclipai/execution-target-kubernetes
    routes/
      agent-callback.ts                  # /api/agent-auth/exchange + /api/runs/:runId/events
      agent-callback.test.ts             # (extend cursor-cloud's existing route)
      workspace-git-credentials.ts       # NEW — /api/workspace/git-credentials
    services/
      cluster-connections.ts             # NEW — stored cluster connections (kubeconfig refs)
      cluster-tenant-policies.ts         # NEW — quota/limit/image-override policies per tenant
      workspace-strategy/                # REFACTORED — extracted shared library used by init container

ui/
  src/
    adapters/
      execution-target/
        kubernetes-fields.tsx            # NEW — exec-target form for "kubernetes"
    pages/
      ClusterConnections.tsx             # NEW — operator UI: list, add, health
      ClusterConnectionDetail.tsx        # NEW — per-cluster: namespaces, quotas, runs

docker/
  agent-runtime/                         # NEW — Paperclip-maintained runtime images
    Dockerfile.base                      # distroless or ubuntu-slim + node + git + tini + nonroot
    Dockerfile.claude                    # base + claude-code CLI
    Dockerfile.codex
    Dockerfile.gemini
    Dockerfile.opencode
    Dockerfile.acpx
    Dockerfile.pi
    Dockerfile.hermes
```

### 1.3 Data flow for one agent run

```
Paperclip server (control plane)

  Heartbeat fires for agent A in company C
       │
       ▼
  Adapter.execute(ctx) — ctx.executionTarget.kind === "kubernetes"
       │
       ▼
  KubernetesExecutionDriver.run(ctx):
   1. resolve cluster connection (from ctx.executionTarget.clusterConnectionId)
   2. ensure namespace `paperclip-{companySlug}` (idempotent)
   3. ensure RBAC, ResourceQuota, LimitRange, NetworkPolicies, image pull secret
   4. ensure PVC `agent-{agentSlug}-workspace` (RWO, default StorageClass)
   5. mint bootstrap token + run JWT scope
   6. resolve secret_refs → materialize per-Job Secret (OwnerRef → Job)
   7. submit Job:
        initContainer  paperclip-workspace-init  → /workspace via existing strategy
        container      agent-runtime-{adapterType}  → exec adapter CLI in /workspace
   8. open k8s pods/log watch → forward chunks to ctx.onLog("stdout", chunk)
   9. open k8s Events watch (Job + Pod) → forward warnings to onLog with [k8s] prefix
  10. await Job completion or cancellation
  11. read terminal status + map to AdapterExecutionResult (codes per §7.2)
  12. TTLAfterFinished cleans up Job + Secret; PVC retained
       ▲
       │ Pod callbacks via /api/agent-auth/exchange + run JWT
       │
  Cluster (in-cluster or remote via stored kubeconfig)
    Namespace: paperclip-{companySlug}
      Job: agent-{agentSlug}-run-{ulid}
        Pod
          initContainer: paperclip-workspace-init  (resolves project_workspaces strategy)
          container:     agent-runtime             (runs adapter CLI; logs via API)
        volumes:
          workspace  ← PVC agent-{agentSlug}-workspace (retained between runs)
          tmp        ← emptyDir 1Gi
          env        ← Secret agent-{agentSlug}-run-{ulid}-env (OwnerRef: Job)
      NetworkPolicy: deny-all + paperclip-agent-egress
      ResourceQuota / LimitRange (per-tenant policy)
```

### 1.4 Why this shape

- **Reuses the existing executionTarget seam** — adapters do not change.
- **Single trust boundary** — the namespace.
- **No long-running daemon** — orchestrator is library code; no operator, no CRDs in V1.
- **Built on k8s primitives** — `Job`, `OwnerReference`, `ResourceQuota`, `NetworkPolicy`, `PodSecurityAdmission`. Less code we own.
- **Cross-cluster-ready from day one** — cluster connection is a stored kubeconfig ref; in-cluster is one connection type among many.

---

## 2. Tenancy, Isolation & Cluster Connection

### 2.1 Tenant boundary: `Namespace` per company

**Naming.** `paperclip-{companySlug}` primary. Fallback `paperclip-{companySlug}-{base36(blake3(companyId))[:8]}` when:
- slug overflows 63 chars after the `paperclip-` prefix (so slug ≤ 53 chars), or
- a different company already owns that name in the same cluster (collision).

The `paperclip.ai/company-id=<uuid>` label is the immutable machine identifier; the namespace name can change in edge cases without breaking identity.

**Provisioning.** First time an agent in company C runs against cluster K, the driver runs an idempotent ensure-namespace path that creates (or upserts):

| Object | Purpose |
|---|---|
| `Namespace` with labels `paperclip.ai/company-id`, `paperclip.ai/managed-by=paperclip`, PSS labels (`pod-security.kubernetes.io/enforce: restricted`, `audit: restricted`, `warn: restricted`) | Tenant root + admission profile |
| `ServiceAccount paperclip-agent` with `automountServiceAccountToken: false` | Pod identity (zero RBAC by default) |
| `ResourceQuota paperclip-tenant-quota` | Compute/storage/pod caps |
| `LimitRange paperclip-tenant-limits` | Default + max per-pod requests/limits |
| `NetworkPolicy default-deny-ingress` + `default-deny-egress` | Zero-trust baseline |
| `NetworkPolicy paperclip-agent-egress` (vanilla) | L3/L4 allowlist |
| `CiliumNetworkPolicy paperclip-agent-egress-l7` (when Cilium present) | L7/FQDN allowlist |
| Optional `Secret paperclip-image-pull` | Per-tenant registry credentials |

All objects carry `paperclip.ai/managed-by=paperclip` and `paperclip.ai/company-id=<id>`. The driver refuses to mutate any namespace lacking `paperclip.ai/managed-by=paperclip`.

**Lifecycle.** Company archive → namespace labeled `paperclip.ai/archived=true`, quotas zeroed, retained for the standard data-retention grace period (default 30 days, matches plugin spec § 25.1). Operator purge via `paperclipai cluster purge --company <id>`.

### 2.2 Pod identity: zero-trust by default

The pod's ServiceAccount has **no RBAC**. `automountServiceAccountToken: false` is set on the pod spec. The driver's k8s identity (server-side) is a separate ServiceAccount (in-cluster) or kubeconfig user (cross-cluster) bound only to namespaces matching `paperclip-*`.

### 2.3 NetworkPolicy: default-deny + allowlist (L3/L4)

```yaml
# default-deny-ingress
podSelector: {}
policyTypes: [Ingress]

---
# default-deny-egress
podSelector: {}
policyTypes: [Egress]

---
# paperclip-agent-egress (only the agent role)
podSelector: { matchLabels: { paperclip.ai/role: agent-runtime } }
policyTypes: [Egress]
egress:
  - to: # cluster DNS
      - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
        podSelector:       { matchLabels: { k8s-app: kube-dns } }
    ports: [{ port: 53, protocol: UDP }, { port: 53, protocol: TCP }]
  - to: # in-cluster Paperclip control plane (when topology = same-cluster)
      - namespaceSelector: { matchLabels: { paperclip.ai/role: control-plane } }
        podSelector:       { matchLabels: { app.kubernetes.io/name: paperclip-server } }
    ports: [{ port: 443, protocol: TCP }, { port: 3102, protocol: TCP }]
  - to: # internet egress with internal ranges denied
      - ipBlock:
          cidr: 0.0.0.0/0
          except:
            - 10.0.0.0/8
            - 172.16.0.0/12
            - 192.168.0.0/16
            - 169.254.0.0/16   # link-local incl. cloud metadata
            - 100.64.0.0/10    # CGNAT
            - fd00::/8         # IPv6 ULA
    ports: [{ port: 443, protocol: TCP }]
```

The `except` blocks are the load-bearing security control: a compromised pod cannot reach cloud metadata, in-cluster databases, or internal services.

### 2.4 Cilium variant (auto-detected, additive)

When the cluster has `CiliumNetworkPolicy` available, the orchestrator generates a CNP **alongside** the vanilla NetworkPolicy. Vanilla stays as defense-in-depth.

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: paperclip-agent-egress-l7
spec:
  endpointSelector: { matchLabels: { paperclip.ai/role: agent-runtime } }
  egress:
    - toFQDNs:
        - matchPattern: "*.anthropic.com"
        - matchPattern: "api.openai.com"
        - matchPattern: "*.googleapis.com"
        - matchPattern: "github.com"
        - matchPattern: "*.github.com"
        - matchPattern: "gitlab.com"
        # ...composed from adapter.networkRequirements + tenantPolicy.additionalAllowFqdns
      toPorts: [{ ports: [{ port: "443", protocol: TCP }] }]
    - toEndpoints: [{ matchLabels: { paperclip.ai/role: control-plane } }]
      toPorts: [{ ports: [{ port: "443", protocol: TCP }] }]
```

### 2.5 Pod Security Admission: `restricted`

Namespace labeled `pod-security.kubernetes.io/enforce|audit|warn: restricted`. Every pod spec sets:

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
      readOnlyRootFilesystem: true     # tmpfs at /tmp; PVC at /workspace
      capabilities: { drop: [ALL] }
```

Satisfies NSA/CISA Kubernetes Hardening Guidance and CIS Kubernetes Benchmark.

### 2.6 ResourceQuota & LimitRange

Defaults (overridable per company plan in `cluster_tenant_policies`):

```yaml
# ResourceQuota
hard:
  requests.cpu:                    "16"
  requests.memory:                 "64Gi"
  limits.cpu:                      "64"
  limits.memory:                   "256Gi"
  requests.storage:                "200Gi"
  count/jobs.batch:                "100"
  count/persistentvolumeclaims:    "50"
  count/secrets:                   "200"
  count/configmaps:                "200"

# LimitRange
limits:
  - type: Container
    default:        { cpu: "1",    memory: "2Gi" }
    defaultRequest: { cpu: "250m", memory: "512Mi" }
    max:            { cpu: "8",    memory: "32Gi" }
  - type: PersistentVolumeClaim
    max: { storage: "20Gi" }
```

When a billing tier change happens, the driver re-applies the new quota.

### 2.7 Cluster connection storage

```ts
interface ClusterConnection {
  id: string;
  label: string;
  kind: "in-cluster" | "kubeconfig";
  kubeconfigSecretRef?: SecretRef;     // resolved via Paperclip secret provider
  apiServerUrl?: string;               // for display only
  defaultNamespacePrefix: string;      // default "paperclip-"
  capabilities: {
    cilium: boolean;                   // auto-detected at connect time
    storageClass: string;              // e.g. "gp3", "longhorn"
    architectures: ("amd64" | "arm64")[];
  };
  paperclipPublicUrl?: string;          // override for cross-cluster topology
  imageRegistry?: string;               // override for ghcr.io/paperclipai/*
  createdAt: string;
  createdBy: string;
}
```

V1: instance-level operator-managed cluster connections (`pnpm paperclipai cluster add`). V2: per-company BYO cluster.

### 2.8 Compliance bookkeeping

- ✅ NSA/CISA Kubernetes Hardening Guidance — Restricted PSS, NetworkPolicy default-deny, no privilege escalation, no host network/PID/IPC, drop ALL caps, RuntimeDefault seccomp.
- ✅ CIS Kubernetes Benchmark — namespace isolation, ResourceQuota, no auto-mounted SA tokens.
- ✅ Internal blast-radius isolation — RFC1918 + link-local egress blocked, no shared SA across tenants.

The release pipeline runs `kube-audit-kit` and `polaris` against a freshly provisioned tenant namespace; PSS Restricted violations or NSA Hardening regressions block release.

---

## 3. Pod Lifecycle

### 3.1 Job spec

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: agent-{agentSlug}-run-{ulid}
  namespace: paperclip-{companySlug}
  labels:
    paperclip.ai/managed-by: paperclip
    paperclip.ai/company-id: <uuid>
    paperclip.ai/agent-id:   <uuid>
    paperclip.ai/run-id:     <uuid>
    paperclip.ai/role:       agent-runtime
spec:
  backoffLimit: 0                        # Paperclip owns retry semantics
  ttlSecondsAfterFinished: 300           # log harvest, then GC
  activeDeadlineSeconds: <min(adapterConfig.timeoutSec, namespaceQuota.maxRunSeconds)>
  completions: 1
  parallelism: 1
  podFailurePolicy:
    rules:
      - action: FailJob
        onPodConditions: [{ type: PodHasNetwork, status: "False" }]
      - action: FailJob
        onExitCodes: { containerName: agent, operator: In, values: [137] }   # OOM
  template:
    metadata:
      labels:
        paperclip.ai/role: agent-runtime
        paperclip.ai/agent-id: <uuid>
        paperclip.ai/run-id:   <uuid>
      annotations:
        paperclip.ai/job-spec-version: "v1"
    spec:
      automountServiceAccountToken: false
      serviceAccountName: paperclip-agent
      restartPolicy: Never
      enableServiceLinks: false
      terminationGracePeriodSeconds: 30
      securityContext: { ... restricted PSS ... }
      initContainers: [ workspace-init ]
      containers:    [ agent ]
      volumes:
        - name: workspace
          persistentVolumeClaim: { claimName: agent-{agentSlug}-workspace }
        - name: tmp
          emptyDir: { sizeLimit: 1Gi }
        - name: env
          secret: { secretName: agent-{agentSlug}-run-{ulid}-env, defaultMode: 0400 }
        - name: skills-pointer
          configMap: { name: paperclip-skills-pointer }
```

Key choices:
- `backoffLimit: 0` — Paperclip owns retry semantics (`AdapterExecutionErrorFamily`, `retryNotBefore`). K8s never retries.
- `ttlSecondsAfterFinished: 300` — gives log-watch time to drain final stdout, then GC removes Job + Pod + per-run Secret via `OwnerReferences`.
- `activeDeadlineSeconds` — clamped to `min(adapterConfig.timeoutSec, namespaceQuota.maxRunSeconds)`.
- `podFailurePolicy` — surfaces image-pull and OOM as terminal failures rather than consuming retry budget.
- `automountServiceAccountToken: false` — agent has no business calling the k8s API.
- `enableServiceLinks: false` — avoids env-var noise and minor info leak.

### 3.2 Init container: workspace bootstrap

```yaml
initContainers:
  - name: workspace-init
    image: ghcr.io/paperclipai/agent-runtime-base:{paperclipVersion}
    command: ["/usr/local/bin/paperclip-workspace-init"]
    env:
      - name: PAPERCLIP_WORKSPACE_STRATEGY
        value: <serialized strategy from project_workspaces>
      - name: PAPERCLIP_WORKSPACE_ROOT
        value: /workspace
      - name: PAPERCLIP_RUN_ID
        value: <run-id>
      - name: PAPERCLIP_BOOTSTRAP_TOKEN
        valueFrom: { secretKeyRef: { name: agent-{agentSlug}-run-{ulid}-env, key: BOOTSTRAP_TOKEN } }
    volumeMounts:
      - { name: workspace, mountPath: /workspace }
      - { name: tmp,       mountPath: /tmp }
    securityContext: { ... restricted ... }
    resources:
      requests: { cpu: 200m, memory: 256Mi }
      limits:   { cpu: "2",  memory: 1Gi }
```

`paperclip-workspace-init` behavior:

1. Reads `PAPERCLIP_WORKSPACE_STRATEGY` (existing strategy types: `git-clone`, `git-worktree`, `existing-path` (rejected at validation), `none`).
2. Cold PVC → full strategy. Git creds obtained via bootstrap-token → run-JWT exchange → `/api/workspace/git-credentials`. Creds written to init container's tmpfs only.
3. Warm PVC → `git fetch && git reset --hard {ref}` (configurable; matches local adapter semantics).
4. Writes `.paperclip-workspace-state.json` marker.
5. Non-zero exit → Job fails with `errorCode: workspace_init_failed`.

Init container shares the PVC with the main container but **not** the env Secret mount — credentials never leak forward.

### 3.3 Main container: agent runtime

```yaml
containers:
  - name: agent
    image: <resolved per §5.2>
    imagePullPolicy: IfNotPresent
    workingDir: /workspace
    command: ["/usr/local/bin/tini", "--"]
    args:    ["/usr/local/bin/paperclip-agent-shim", "--adapter", "<type>"]
    env:
      - name: PAPERCLIP_RUN_ID
        value: <run-id>
      - name: PAPERCLIP_PUBLIC_URL
        value: <resolved per §6.5>
      - name: PAPERCLIP_BOOTSTRAP_TOKEN
        valueFrom: { secretKeyRef: { name: ...env, key: BOOTSTRAP_TOKEN } }
      - name: TRACEPARENT
        value: <propagated from server span>
      # ...adapter-specific keys (LLM keys, etc.) from the per-Job Secret
    volumeMounts:
      - { name: workspace,       mountPath: /workspace }
      - { name: tmp,             mountPath: /tmp }
      - { name: env,             mountPath: /run/paperclip/env, readOnly: true }
      - { name: skills-pointer,  mountPath: /run/paperclip/skills, readOnly: true }
    resources:
      requests: { cpu: <from adapter or LimitRange default>, memory: ... }
      limits:   { cpu: ...,                                  memory: ... }
    securityContext:
      runAsNonRoot: true
      readOnlyRootFilesystem: true
      allowPrivilegeEscalation: false
      capabilities: { drop: [ALL] }
      seccompProfile: { type: RuntimeDefault }
```

`tini` as PID 1 ensures SIGTERM forwarding. `paperclip-agent-shim`:
1. Reads `AdapterRuntimeCommandSpec` from a config file projected by the orchestrator.
2. Detects the adapter CLI (`installCommand` if missing).
3. Reads the prerendered prompt (orchestrator-rendered).
4. Exec-replaces itself into the actual adapter CLI so signals propagate.
5. Frames structured stdout events compatible with existing UI parsers.

No sidecars in V1. Logs flow via `pods/log` watch + structured-events callback (§3.4).

### 3.4 Output streaming

Two parallel streams merged by timestamp:

| Source | Mechanism |
|---|---|
| stdout/stderr | `pods/log` watch with `sinceTime` reconnect → `ctx.onLog("stdout", chunk)` |
| Structured events | `POST /api/runs/:runId/events` from agent shim with run JWT |
| K8s `Event`s on Job/Pod | Events watch → `ctx.onLog("stdout", "[k8s] " + event)` |

If the structured-events callback is unreachable (NetworkPolicy misconfig), events fall back to stdout framing — degraded but not broken.

### 3.5 Cancellation

User cancels run → registered cancellation handler:
1. `kubectl delete job <name> --propagation-policy=Foreground --grace-period=30`
2. K8s sends SIGTERM to PID 1 → `tini` → adapter CLI. 30s drain.
3. After grace, SIGKILL.
4. Pod terminates → log watch sees stream end → `AdapterExecutionResult { exitCode: null, signal: "SIGTERM", errorCode: "cancelled" }`.

Foreground propagation ensures the Pod is gone before the API call returns; per-Job Secret GC'd via `OwnerReferences`. PVC untouched.

### 3.6 Concurrent runs on the same agent

PVC is `ReadWriteOnce` — only one pod can mount at a time.
- Paperclip's heartbeat-level locking already prevents overlapping runs per agent.
- Defensive: orchestrator checks for a live Job with the same `paperclip.ai/agent-id` label and returns `errorCode: "concurrent_run_blocked"` immediately rather than queueing.
- For agents that legitimately need concurrent runs, switch the agent's storage class to ReadWriteMany (e.g. EFS, Azure Files, Longhorn) with the perf tradeoff documented.

---

## 4. Workspace Persistence

### 4.1 PVC lifetime is bound to the agent, not the run

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: agent-{agentSlug}-workspace
  namespace: paperclip-{companySlug}
  labels:
    paperclip.ai/managed-by: paperclip
    paperclip.ai/company-id: <uuid>
    paperclip.ai/agent-id:   <uuid>
    paperclip.ai/role:       agent-workspace
  annotations:
    paperclip.ai/workspace-strategy: <strategy-key>
    paperclip.ai/created-at:         <iso>
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: <from ClusterConnection.capabilities.storageClass>
  resources: { requests: { storage: <perAgentDefault, e.g. 10Gi> } }
```

Created on first run, reused for subsequent runs. Never auto-deleted on Job completion.

### 4.2 Zonal pinning

`ReadWriteOnce` cloud disks (EBS, PD-Standard, Azure Disk) are zone-bound. After first bind, the orchestrator reads the bound `PersistentVolume.spec.nodeAffinity` and adds matching `nodeAffinity` to subsequent pods so they land in the same zone. Operators who want multi-zone resilience choose a regional StorageClass (e.g. `pd-balanced` regional, EFS, Longhorn) — purely a StorageClass decision, no orchestrator code change.

### 4.3 Reclaim & GC

- PVC `persistentVolumeReclaimPolicy: Delete` (default for dynamic provisioning).
- Agent archive → PVC labeled `paperclip.ai/archived=true`, retained for grace period (default 30 days).
- Operator `paperclipai cluster purge --agent <id>` → immediate delete.
- Company purge → namespace deletion cascades to all PVCs.
- Daily stale PVC sweep flags PVCs with no matching `agents` row older than 7 days; surfaced in cluster-health UI; never auto-deleted.

### 4.4 Quota interaction

PVC storage counts against `requests.storage` and `count/persistentvolumeclaims` in the namespace `ResourceQuota`. Quota exhaustion → new agents cannot run; orchestrator returns `errorCode: "tenant_storage_quota_exhausted"` with remediation hint.

### 4.5 Workspace strategy → init container interaction

| Strategy | Init container behavior |
|---|---|
| `git-clone` | Cold: `git clone <url> --branch <ref> .`. Warm: `git fetch && git reset --hard origin/<ref>`. |
| `git-worktree` | Cold: `git clone --bare` into `/workspace/.bare` then `git worktree add` per agent slot. Warm: `git fetch` + worktree update. |
| `existing-path` | Rejected at execution-target config validation; not a runtime failure. |
| `none` | Empty `/workspace`. |

Strategy code is **shared** between local adapter and init container by extracting existing logic from `server/src/services/workspace-strategy/` (or wherever it currently lives) into a small library that the init container's binary links against. This is a planned refactor in the implementation plan.

### 4.6 Snapshots & backup (V2, designed-for)

- PVCs labeled and annotated for Velero/Kasten K10 selectors out of the box.
- VolumeSnapshot CRDs reserved for V2 — `paperclipai cluster snapshot agent <id>` would create a `VolumeSnapshot` and a Paperclip record.
- V2 use case: cloning an agent's workspace as the seed for a new agent (`PVC.dataSource: VolumeSnapshot`).

### 4.7 Edge cases

- Init container wedge → `activeDeadlineSeconds` catches.
- Disk full mid-run → `errorCode: workspace_disk_full` with `df` snapshot from `kubectl exec`.
- Corrupt workspace → init container detects `git status` non-clean and falls back to full reset; configurable per agent for agents that want dirty state preserved.
- PVC orphan after stuck `Terminating` namespace → surfaced in cluster-health UI; explicit operator cleanup, never auto-resolved.

---

## 5. Images & Secrets

### 5.1 Image strategy: Paperclip-maintained, adapter-aligned

Family of small images, not one fat image:

| Image | Base | Contains |
|---|---|---|
| `ghcr.io/paperclipai/agent-runtime-base:{paperclipVersion}` | distroless or ubuntu-slim | `tini`, `git`, `paperclip-workspace-init`, `paperclip-agent-shim`, CA bundle, non-root uid/gid 1000 |
| `agent-runtime-claude:{paperclipVersion}` | base | + `@anthropic-ai/claude-code` CLI |
| `agent-runtime-codex:{paperclipVersion}` | base | + Codex CLI |
| `agent-runtime-gemini:{paperclipVersion}` | base | + Gemini CLI |
| `agent-runtime-opencode:{paperclipVersion}` | base | + OpenCode CLI |
| `agent-runtime-acpx:{paperclipVersion}` | base | + ACPX CLI |
| `agent-runtime-pi:{paperclipVersion}` | base | + Pi CLI |
| `agent-runtime-hermes:{paperclipVersion}` | base | + Hermes CLI |

Reasoning:
- Per-adapter images are smaller (~150–250 MB) than a fat kitchen sink image.
- Independent CLI version pinning per adapter.
- Clear failure surface: "Codex CLI not found in image" is impossible because Codex isn't in the Claude image.

`{paperclipVersion}` ties image **tags** to Paperclip release tags so `agent-runtime-claude:v2026.5.8` is unambiguous. The image *contents* (notably the bundled adapter CLI version) follow each adapter's own pinning cadence — a Paperclip release that doesn't bump the Claude CLI ships an `agent-runtime-claude:v2026.5.8` whose layered content is identical to the previous release. This keeps tag→content mapping deterministic without forcing a CLI rebuild on every Paperclip release.

**Multi-arch.** Every image ships `amd64` + `arm64` via `docker buildx`.

**Provenance.** `cosign` keyless OIDC signing in CI; SBOMs (`syft` → SPDX) attached as cosign attestations; `trivy` CVE scanning gates release.

### 5.2 Image resolution: three levels of override

```
Effective image =
  per-agent override     (adapterConfig.kubernetes.image; gated by per-cluster policy)
  ?? per-tenant override (cluster_tenant_policies.imageOverrides[adapterType])
  ?? cluster default     (ClusterConnection.imageRegistry + adapterType)
  ?? Paperclip default   (ghcr.io/paperclipai/agent-runtime-{adapterType}:{paperclipVersion})
```

Per-agent override is gated by `ClusterConnection.allowAgentImageOverride: false` (default false). Even when enabled, the image must satisfy `imagePullPolicy: IfNotPresent` and an admission check that the namespace is not labeled `paperclip.ai/role: control-plane`.

### 5.3 Per-namespace image pull credentials

Per-namespace `kubernetes.io/dockerconfigjson` Secret resolved from the Paperclip secret store at namespace-ensure time. Not auto-rotated (rotation can break in-flight pulls); operator command `paperclipai cluster rotate-pull-secret --connection <id>` for explicit rotation.

### 5.4 Per-Job ephemeral Secret for run credentials

```yaml
apiVersion: v1
kind: Secret
type: Opaque
metadata:
  name: agent-{agentSlug}-run-{ulid}-env
  namespace: paperclip-{companySlug}
  labels:
    paperclip.ai/managed-by: paperclip
    paperclip.ai/run-id: <uuid>
  ownerReferences:
    - apiVersion: batch/v1
      kind: Job
      name: agent-{agentSlug}-run-{ulid}
      uid: <jobUid>
      controller: true
      blockOwnerDeletion: true
data:
  BOOTSTRAP_TOKEN:    <base64>
  ANTHROPIC_API_KEY:  <base64>      # resolved from secret_ref
  GIT_CREDENTIAL_KEY: <base64>      # short-lived handle, exchanged at runtime
  # ...adapter-required keys, all from secret_refs
```

Properties:
- Lifetime tied to the Job via `OwnerReferences` — TTL cleanup of the Job removes the Secret.
- Mounted as **files** at `/run/paperclip/env` (mode 0400, uid 1000), and projected as env vars only for the keys the adapter CLI explicitly needs.
- Materialized at Job-create time (resolve `secret_ref`s, build Secret, submit Job in a single transaction). On Job-create failure, Secret is explicitly deleted (no owner yet to GC it).
- Secret values never written to logs, audit entries, error messages, or `resultJson`. Enforced by a redaction layer keyed by the materialized Secret's value set.

### 5.5 Bootstrap token → run JWT exchange (shared with cursor-cloud)

Same shape as the existing cursor-cloud route at `/api/agent-auth/exchange`:
1. Pod has `BOOTSTRAP_TOKEN` (10 min TTL, run-scoped, single-use, bound to Job UID).
2. `POST /api/agent-auth/exchange { bootstrapToken }` → `{ runJwt, expiresAt }`.
3. Pod uses `runJwt` for `/api/runs/:runId/events`, `/api/skills/*`, `/api/workspace/git-credentials`.

V1.5 second factor: bind the exchange request to the calling Pod's projected ServiceAccount token (`audience: paperclip-runtime`); server's `TokenReview` confirms the caller before issuing the run JWT. Cross-cluster topology defers this to V2 (needs identity federation).

### 5.6 External Secrets Operator (V2, designed-for)

V1 abstracts the per-Job Secret materialization behind a `SecretMaterializer` interface. V2 adds an `ExternalSecretMaterializer` that creates an `ExternalSecret` CR pointing at the customer's Vault/AWS SM/GCP SM and waits for ESO to materialize the underlying Secret before submitting the Job.

### 5.7 Not in V1

- Per-pod kubelet credential provider plugins.
- Paperclip-managed cosign verification policy (we sign; we trust customers' admission controllers to verify).
- Image rebuild on every Paperclip release for every adapter CLI version (CLI bumps follow their own cadence).

---

## 6. Networking & Callback

### 6.1 Three layers of egress control

```
Pod (agent-runtime)
   ↓ ① NetworkPolicy (L3/L4 IP/port)            ← always on
   ↓ ② Cilium L7 / FQDN policy                  ← if cluster supports it (auto-detected)
   ↓ ③ Egress proxy (squid/Envoy)               ← optional, customer-managed
   ↓
external network
```

V1 ships ① and ②. ③ is documented; the runtime image honors `HTTP_PROXY`/`HTTPS_PROXY` env so customers can wire one in via tenant policy.

### 6.2 Layer ① — vanilla NetworkPolicy

See §2.3 for the full policies. The control-plane match-labels are a parameter of the cluster connection: in-cluster topology fills them with the Paperclip server's labels; cross-cluster omits the in-cluster rule entirely.

### 6.3 Layer ② — Cilium variant

See §2.4. The FQDN allowlist is per-tenant + per-adapter:
- `adapter.networkRequirements.allowFqdns` (declared by the adapter package)
- `tenantPolicy.additionalAllowFqdns` (operator-set per company)
- Deny-by-default everywhere else.

### 6.4 Layer ③ — egress proxy

Tenant policy can set `httpProxyUrl: http://proxy.acme-corp.svc.cluster.local:3128`. Orchestrator injects `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`; `NO_PROXY` is auto-populated with kube-dns, the Paperclip Service, and pod/service CIDRs.

### 6.5 Paperclip public URL resolution

Resolution order:
1. **In-cluster topology** → `https://paperclip-server.<paperclipNamespace>.svc.cluster.local:443`. Default when `ClusterConnection.kind === "in-cluster"` and the orchestrator can resolve the server's Service.
2. **Cross-cluster topology** → `ClusterConnection.paperclipPublicUrl`, fallback `process.env.PAPERCLIP_PUBLIC_URL`. Validated reachable from the cluster at connection-add time via a one-shot Job that curls `/api/health`.
3. **Per-agent override** — `adapterConfig.paperclipPublicUrl`. Rare; for agents crossing VPN boundaries.

The resolved URL is injected as a literal `PAPERCLIP_PUBLIC_URL` env var in the pod spec (not in the per-Job Secret — it's not sensitive). The agent shim refuses to start if it's missing.

### 6.6 Callback API surface

| Endpoint | Auth | Used by | Source |
|---|---|---|---|
| `POST /api/agent-auth/exchange` | bootstrap token | first call from pod | shared with cursor-cloud |
| `POST /api/runs/:runId/events` | run JWT | structured events | shared |
| `POST /api/workspace/git-credentials` | run JWT | init container | k8s-specific |

Rate limits on `/api/agent-auth/exchange`: 10/min/companyId, 1000/day/companyId. Bootstrap tokens are single-use; replay → `400 token_already_consumed`. Run JWT bearer-auth on subsequent calls; per-run rate limits 1000 events/min, 100MB/run total.

### 6.7 Failure modes

- DNS down inside cluster → `errorCode: dns_unreachable` with CoreDNS pod status in metadata.
- Cilium policy denies a new domain → drop logs (Hubble) tee'd into run log when available; `errorCode: network_policy_denied`.
- Paperclip server unreachable → bounded backoff (5 attempts, exponential, capped at 30s); after that `errorCode: control_plane_unreachable`, `errorFamily: transient_upstream`.
- Token replay → orchestrator-internal retry once with fresh token, then fail.

---

## 7. Observability, Failure Modes, Testing

### 7.1 Logs

Three tiers feeding the Paperclip run log buffer:

| Source | Mechanism | Latency |
|---|---|---|
| Agent stdout/stderr | `pods/log` watch | live (~100ms) |
| Structured events | `POST /api/runs/:runId/events` from agent shim | live |
| Orchestrator + K8s `Event`s | server-local logs + `heartbeat_run_events` rows + `[k8s]`-prefixed lines | sync |

Tier 3 catches things teams forget: a Job sitting Pending for 90s due to `ImagePullBackOff` shows up in the run log without `kubectl describe`.

### 7.2 Metrics (Prometheus, exposed at server `/metrics`)

```
paperclip_k8s_runs_total{cluster, namespace, adapter_type, outcome}
paperclip_k8s_run_duration_seconds{cluster, namespace, adapter_type}
paperclip_k8s_pod_pending_seconds{cluster, namespace}
paperclip_k8s_pvc_bytes{cluster, namespace, agent_id}
paperclip_k8s_namespace_quota_used_ratio{cluster, namespace, resource}
paperclip_k8s_orchestrator_api_errors_total{cluster, verb, code}
paperclip_k8s_callback_requests_total{endpoint, status_code}
```

Customers worried about cardinality can drop the `namespace` label via Helm values.

### 7.3 Tracing (OpenTelemetry)

Server starts a span on `Adapter.execute`, propagates context as `TRACEPARENT` env into the per-Job Secret. Agent shim continues the trace. One trace per run with spans for orchestrator phases (ensure-namespace, materialize-secret, submit-job, await-completion) plus agent-side spans for prompt rendering and CLI invocation.

### 7.4 Audit

Every orchestrator mutation writes a Paperclip activity log entry with:
- `actorType: "platform_module"`
- `sourceModule: "kubernetes-execution-target"`
- `targetCluster`, `targetNamespace`, `verb`, `outcome`

Sufficient for SOC2-style audit trails.

### 7.5 Failure mode catalog

| Symptom | `errorCode` | Family | Retryable? |
|---|---|---|---|
| Image pull fails | `image_pull_failed` | `transient_upstream` | No (operator must fix image/pull-secret) |
| OOM kill | `oom_killed` | — | No (resize agent's resource request) |
| `activeDeadlineSeconds` hit | `timeout` | — | Per Paperclip's existing timeout policy |
| Init container fails | `workspace_init_failed` | varies | Yes if `transient_upstream` (e.g. git server 503) |
| Disk full | `workspace_disk_full` | — | No (PVC resize or workspace cleanup) |
| Storage quota | `tenant_storage_quota_exhausted` | — | No (billing event) |
| Compute quota | `tenant_compute_quota_exhausted` | — | No (billing event) |
| Cluster unreachable from server | `cluster_unreachable` | `transient_upstream` | Yes |
| Pod can't reach Paperclip | `control_plane_unreachable` | `transient_upstream` | Yes (with backoff) |
| Cilium FQDN denied | `network_policy_denied` | — | No (operator must update policy) |
| Concurrent run blocked | `concurrent_run_blocked` | — | Yes after current run completes |
| Bootstrap token replay | `token_replay` | — | No (orchestrator retries once internally, then fails) |
| Pod stuck `Pending` >5min | `pod_scheduling_failed` | `transient_upstream` | Yes (autoscaler may catch up) |
| Workspace strategy unsupported on this target | `execution_target_unsupported_strategy` | — | No (config-validation-time error) |
| DNS unreachable | `dns_unreachable` | `transient_upstream` | Yes |
| User-initiated cancellation | `cancelled` | — | No (terminal by user intent) |

Every code is documented with an inline UI remediation hint.

### 7.6 Testing strategy

**Unit (no cluster).** Bulk of suite. Pure builders:
- Job spec builder → expected YAML (golden snapshots).
- NetworkPolicy generator (vanilla + Cilium).
- ResourceQuota / LimitRange builder per plan tier.
- RBAC binding generator.
- Secret materialization → no plaintext leakage in any return value.
- ClusterConnection validation, namespace-name derivation, slug truncation.
- Redaction layer on log lines, error messages, `resultJson`.

**Integration (real cluster).** `kind`/`k3d` cluster spun up in CI via `testcontainers-node`:
- Full run lifecycle for `claude_local` against a fake LLM endpoint.
- Cancellation mid-run — Job deleted within grace, no orphan PVC/Secret.
- Quota enforcement — submit 11 Jobs with quota of 10; 11th rejected with the right error code.
- Multi-tenant isolation — two namespaces, concurrent agents, probe pod that tries cross-namespace traffic must fail.
- PSS Restricted compliance — privileged Pod rejected at admission.
- Image pull failure path → `errorCode: image_pull_failed` within 60s.
- Workspace warm vs cold — second run faster, PVC reused.

**Contract.** Every public type the driver exports has a contract test; the execution-target driver registry interface is the most important.

**Security review gate.** `kube-audit-kit` and `polaris` run against a freshly provisioned tenant namespace in CI. PSS Restricted violations or NSA Hardening regressions block release.

**Load.** Synthetic 100-concurrent-run test against `kind` to validate the orchestrator's k8s API call rate stays under default `--max-requests-inflight`. The orchestrator uses a shared informer + workqueue pattern, not raw `watch` per Job.

---

## V1 Scope (Ships)

- ✅ `KubernetesExecutionTarget` kind in `executionTarget`
- ✅ `@paperclipai/execution-target-kubernetes` package — orchestrator + driver
- ✅ `ClusterConnection` model + storage + UI form
- ✅ Namespace-per-company provisioning with all isolation primitives (RBAC, ResourceQuota, NetworkPolicy, PSS labels, image pull secret)
- ✅ Job-per-run with PVC-per-agent + init container workspace strategy
- ✅ Per-Job ephemeral Secret materialization with redaction layer
- ✅ Bootstrap-token → run-JWT auth path (extends cursor-cloud-shared route)
- ✅ K8s log watch + structured events callback + K8s Events forwarding
- ✅ Cancellation, TTL cleanup, OwnerReference GC
- ✅ Cilium auto-detection + CNP variant
- ✅ Paperclip-maintained agent runtime image family (multi-arch, signed)
- ✅ Per-namespace image pull credentials
- ✅ Operator UI: cluster connection list, per-cluster health, per-tenant quota dashboard
- ✅ Failure-mode error codes with remediation hints
- ✅ Audit log integration
- ✅ Test suite (unit + kind integration + security gate)
- ✅ Documentation: quickstart, security model, multi-tenant onboarding playbook
- ✅ Workspace-strategy refactor: extract shared library used by init container

## V2 (Designed-for, Deferred)

- 🟡 BYO cluster per company (today: per-instance only).
- 🟡 Pod-per-agent mode (StatefulSet + KEDA scale-to-zero) as a per-adapter knob.
- 🟡 External Secrets Operator integration via `SecretMaterializer` interface.
- 🟡 VolumeSnapshot-based agent cloning.
- 🟡 `PaperclipAgentRun` CRD + reconciliation operator (only if needed).
- 🟡 Helm chart for the Paperclip control plane itself.
- 🟡 Fine-grained image attestation (cosign verify in admission).
- 🟡 IPv6 dual-stack pod support (V1 deny-list is IPv4-shaped).
- 🟡 Cross-cluster TokenReview second-factor (needs identity federation).

---

## Risks & Open Questions

1. **Workspace strategy refactor scope.** Lifting workspace-strategy code out of `server/` into a shared library is a real refactor. The implementation plan must scope it precisely to avoid creep.
2. **PVC zonal pinning UX.** First-zone-binds-forever is correct but surprising. Cluster-connection setup must explicitly call this out, with regional StorageClass guidance front-and-center.
3. **`executionTarget` plumbing audit.** This spec assumes every existing adapter (`claude_local`, `codex_local`, etc.) plumbs `executionTarget` correctly through to its execute path. The implementation plan must include an audit and any plumbing fixes.
4. **Resource defaults for `claude_local` in a Pod.** Long sessions can spike memory significantly. Need empirical numbers (50 representative agents in `kind`, capture p99 memory) before locking LimitRange defaults. Defaults in this spec are a starting point. **RESOLVED in M3a (sizing.md scaffold + measurement test in place; operator runs the test out-of-band)**
5. **Cross-cluster TokenReview.** The V1.5 second-factor on `/api/agent-auth/exchange` needs identity federation between clusters. Documented as V2.
6. **`registerExecutionTargetDriver()` doesn't exist yet.** The platform-module registry surface is extended in this spec; the implementation plan should add the registry as a small explicit step before plugging in the k8s driver.
7. **Adapter `networkRequirements` field doesn't exist on `ServerAdapterModule` yet.** Adding `networkRequirements?: { allowFqdns?: string[] }` to the adapter contract is a small addition the implementation plan must include.
8. **Agent shim binary.** `paperclip-agent-shim` is new code. Scope, language (Go for static binary preferred), and packaging into the runtime image must be designed in the implementation plan.

---

## Appendix: Decision Log

| Decision | Chosen | Rejected alternative(s) | Reason |
|---|---|---|---|
| Extension shape | New `kubernetes` kind on `AdapterExecutionTarget` | New `kubernetes_pod` adapter; CRD/operator | Highest leverage; every adapter inherits k8s; smallest blast radius |
| Tenant boundary | Namespace per company | Cluster per company; label-based isolation | K8s-native; free isolation primitives; cluster-per-company doesn't scale |
| Workload granularity | Job-per-run + PVC-per-agent | Pod-per-company (shared); pod-per-agent (default); pod-per-run (ephemeral PVC) | Strict isolation per run + warm workspaces; pod-per-company has poor isolation and doesn't actually save cluster cost |
| Topology | Hybrid (in-cluster + cross-cluster) with bootstrap auth | Same-cluster only; cross-cluster only | One auth path serves both deployments |
| Orchestration runtime | Imperative `@kubernetes/client-node` from server | CRD + Go operator; CRD + TS operator | Smallest moving parts; reuse k8s primitives; runs are ephemeral |
| Workspace bootstrap | Init container running existing strategy | Server pre-populates via `kubectl cp`; one-shot prepare Job | Reuses strategy code; same FS layout as local; scales cross-cluster |
| Namespace naming | `paperclip-{companySlug}` (operator-friendly) | `paperclip-{shortHash}` (collision-safe by construction) | kubectl debuggability; immutable label remains canonical |
| FQDN egress control | Cilium auto-detected; vanilla NetworkPolicy as floor | FQDN-required (Cilium hard dep); egress proxy required | Works with any CNI; tightens when Cilium is present; floor blocks RFC1918 + link-local |
| Secret injection | Native k8s Secret per Job, OwnerRef-GC'd, mounted as files | ExternalSecrets Operator (V2); CSI Secret Store (V2) | Simplest correct V1; abstraction in place for V2 drivers |
| Retry semantics | Owned by Paperclip (`backoffLimit: 0`) | Owned by k8s (`backoffLimit: 6`); shared | Paperclip already has `AdapterExecutionErrorFamily` + `retryNotBefore`; double-retry breaks billing/audit |

---

## M3a status (as of 2026-05-09)

Risk #4 (empirical resource defaults) is RESOLVED — `docs/k8s-execution/sizing.md` and `packages/adapters/kubernetes-execution/test/integration/empirical-measurement-claude.test.ts` together provide the measurement infrastructure; defaults retain M1's values pending operator measurement runs.

M3a addendum at `docs/superpowers/specs/2026-05-09-paperclip-cloud-adapter-m3a-addendum.md` covers the four §1-§4 items: real claude-code test, real issueGitCredentials, empirical sizing, per-tenant Cilium DSL.

*Spec ends.*

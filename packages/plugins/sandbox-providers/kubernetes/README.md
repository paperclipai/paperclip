# @paperclipai/plugin-kubernetes (alpha)

First-party Paperclip sandbox-provider plugin for Kubernetes.

**Alpha:** the default backend (`sandbox-cr`) is built on `kubernetes-sigs/agent-sandbox` v1alpha1 — expect breaking changes as that CRD evolves toward Beta. A stable fallback backend (`job`, using `batch/v1` Job) is available for clusters without agent-sandbox installed, but it does NOT support multi-command exec (paperclip-server's adapter-install pattern requires sandbox-cr).

## Prerequisites

### For `sandbox-cr` backend (default, recommended)

1. A Kubernetes cluster running k8s 1.27+
2. [`kubernetes-sigs/agent-sandbox`](https://github.com/kubernetes-sigs/agent-sandbox) controller installed in the cluster (alpha — installs the `sandboxes.agents.x-k8s.io/v1alpha1` CRD and controller)
3. Paperclip-server running with access to the cluster (in-cluster via `inCluster: true` or external via `kubeconfig`)

### For `job` backend (stable fallback)

1. A Kubernetes cluster running k8s 1.27+
2. Paperclip-server with cluster access — no additional controllers or CRDs required

## Installation

```bash
paperclipai plugin install @paperclipai/plugin-kubernetes
```

Or, for local development:

```bash
paperclipai plugin install --local /path/to/paperclip/packages/plugins/sandbox-providers/kubernetes
```

## Backends

The plugin supports two backend modes, selected via the `backend` config field:

| Backend | Default | Stability | Multi-command exec | Requires |
|---|---|---|---|---|
| `sandbox-cr` | Yes | Alpha | Yes | `kubernetes-sigs/agent-sandbox` controller |
| `job` | No | Stable | No | Nothing beyond k8s 1.27+ |

**`sandbox-cr` (default):** Creates a `Sandbox` CR (`agents.x-k8s.io/v1alpha1`) whose controller provisions a long-lived pod running `sleep infinity`. paperclip-server execs individual commands into the running pod — this is the multi-command adapter-install pattern. When you `releaseLease`, the Sandbox CR is deleted and the controller tears down the pod.

**`job` (stable fallback):** Creates a `batch/v1` Job. The container entrypoint runs once and exits — no multi-command exec possible. Use this when you cannot install agent-sandbox, or when you need strictly stable Kubernetes APIs. Note: paperclip-server's adapter-install pattern will not work in job mode.

### Migrating from `job` to `sandbox-cr`

1. Install the agent-sandbox controller: `kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/install.yaml`
2. Update your environment config to set `backend: "sandbox-cr"` (or remove `backend` since `sandbox-cr` is the default)
3. New leases will use the Sandbox CR backend. Existing leases created with `job` mode continue to use job semantics until they are released.

## Configuration

Create a `sandbox` environment with `driver: kubernetes`. One of these auth fields is required:

- `inCluster: true` — use the in-pod ServiceAccount credentials (when paperclip-server runs inside the same cluster).
- `kubeconfig: <YAML>` — inline kubeconfig (stored as a company secret).
- `kubeconfigSecretRef: <secret-uuid>` — reference to an existing Paperclip secret.
- `auth: { type: "eks-iam", clusterName, region, endpoint, caData }` — EKS IAM auth with the server's own AWS identity (for example the ECS task role); no secret is stored. See below.

### EKS IAM auth (`auth.type: "eks-iam"`)

The plugin worker signs a short-lived EKS token itself (a presigned STS `GetCallerIdentity` URL with `x-k8s-aws-id: <clusterName>` signed in, as `aws eks get-token` does) from the AWS SDK default credential chain. It caches one token per cluster in memory, mints a new one when less than 5 minutes of its 14-minute life are left, and attaches it to every API request and every exec/watch WebSocket connect. The token never enters the environment config. `endpoint` must be the `https://...eks.amazonaws.com` API endpoint and `caData` the base64 cluster CA (both from `aws eks describe-cluster`).

Operator setup:

- Set `PAPERCLIP_K8S_EKS_IAM_ALLOWED_CLUSTERS` on the server to comma-separated `<clusterName>=<endpoint>` pairs, e.g. `paperclip-prod-sandbox=https://ABC.gr7.us-east-1.eks.amazonaws.com`. An environment can use eks-iam only with a cluster name and endpoint that match an entry. Only when it is set does the server forward its AWS credential pointers (`AWS_CONTAINER_CREDENTIALS_*`, web identity, region; never static keys) to this plugin's worker.
- Give the server's IAM role an EKS access entry (type `STANDARD`) mapping it to a Kubernetes group bound to the plugin's RBAC. No IAM policy is needed for `sts:GetCallerIdentity`.

Common optional fields:

| Field | Default | Purpose |
|---|---|---|
| `backend` | `"sandbox-cr"` | `sandbox-cr` (alpha, requires agent-sandbox controller) or `job` (stable, one-shot entrypoint). |
| `adapterType` | `"claude_local"` | One of the supported adapter types (claude_local, codex_local, gemini_local, cursor_local, opencode_local, pi_local). Determines runtime image + env keys + egress allow-list. |
| `namespacePrefix` | `"paperclip-"` | Prefix for the per-company tenant namespace. |
| `companySlug` | derived from companyId | Override the auto-derived company slug. |
| `imageRegistry` | (none) | Override the default registry for agent runtime images. |
| `imageAllowList` | `[]` | Glob patterns of allowed `target.imageOverride` values. Empty = no override permitted. |
| `imagePullSecrets` | `[]` | Names of pre-created Docker image pull secrets in the tenant namespace. |
| `egressAllowFqdns` | `[]` | Additional FQDNs (beyond adapter defaults like `api.anthropic.com`). |
| `egressAllowCidrs` | `[]` | Additional CIDRs to allow egress to. |
| `egressMode` | `"standard"` | `standard` (NetworkPolicy + CIDRs) or `cilium` (CiliumNetworkPolicy + FQDN allow-list). |
| `runtimeClassName` | (none) | e.g. `kata-fc` for Firecracker-backed microVMs. Cluster must have the RuntimeClass installed. |
| `serviceAccountAnnotations` | `{}` | Annotations applied to per-tenant ServiceAccount (e.g. IRSA `eks.amazonaws.com/role-arn`). |
| `jobTtlSecondsAfterFinished` | `900` | Seconds after a Job completes before garbage-collection. |
| `podActivityDeadlineSec` | `3600` | Hard ceiling on a single run's wall-clock time. |
| `podReadyTimeoutSec` | `90` | Longest a run waits for its sandbox pod to become Ready. Independent of the run timeout. |
| `resourceQuota` | see below | Per-company ResourceQuota for the tenant namespace (`pods`, `requestsCpu`, `requestsMemory`, `limitsCpu`, `limitsMemory`). |

Full JSON Schema in `src/manifest.ts`.

### Per-company capacity and over-capacity behavior

**Tenant namespace ownership.** Before the plugin creates or changes anything in a tenant namespace, it checks that the namespace's `paperclip.io/company-id` label equals the run's company id. A namespace with a different label, or with no label, is refused and the acquire fails with an error naming the namespace and the run's company (the error never names another company's id). This always applies; there is no setting to turn it off. It protects against a wrong or shared `companySlug` running one company's agents in another company's namespace. The label is read in the same call that already checks the namespace exists, and the result is cached with the rest of the tenant setup (re-verified at most every 5 minutes; a refusal is not cached, so a corrected label takes effect on the next acquire). Releasing, destroying and resuming a lease use the namespace recorded on the lease and do not run the check, so a pod the plugin created can always be cleaned up. If the namespace does not exist and the server cannot create namespaces (the usual production setup, where an operator provisions each namespace), the run fails with a "not enabled for Kubernetes sandboxes" error instead of a raw 403. A namespace the plugin creates itself is labelled for the company automatically.

*Operator migration step.* Before deploying this check, make sure every existing tenant namespace carries the label. List the ones that do not: `kubectl get namespaces -l '!paperclip.io/company-id'` (then pick the tenant namespaces from that list). For each tenant namespace that belongs to a company, run `kubectl label namespace <namespace> paperclip.io/company-id=<company id>`. A namespace shared by two companies, or with a placeholder label, must be fixed or split first; the check will refuse it from then on.

Each company's tenant namespace gets a `ResourceQuota` (`paperclip-quota`). Defaults, all overridable per environment under `resourceQuota`:

```json
{ "resourceQuota": { "pods": "20", "requestsCpu": "5", "requestsMemory": "10Gi", "limitsCpu": "40", "limitsMemory": "80Gi" } }
```

When a company is at its pod quota there is **no queue**: a new run fails fast with an `Over capacity` error. The plugin checks the quota before creating a Sandbox (acquire fails in about a second), reads quota-rejection messages from the Sandbox status while waiting, and bounds the pod-Ready wait by `podReadyTimeoutSec` (default 90 s) instead of the run timeout. Pod readiness is polled every 500 ms.

**Changing the quota for existing companies.** Edit `resourceQuota` on the environment. The plugin reconciles `paperclip-quota` `spec.hard` to the configured values the next time it provisions a lease for that namespace (a changed `resourceQuota` is part of the cached setup fingerprint, so it is applied on the very next acquire; unchanged setup is re-verified at most every 5 minutes). This needs `update` on `resourcequotas` in the tenant namespaces for the server's Kubernetes credentials (`get`/`create` alone are not enough); if it is missing the plugin logs a warning naming the missing permission and the old quota stays in force. Other tenant objects (RBAC, NetworkPolicies, LimitRange) remain create-once: change those by deleting the object, or the namespace, and the next run recreates it. Sizing: ResourceQuota counts limits, and each pod defaults to requests 250m / 512Mi and limits 2 CPU / 4Gi. The defaults are therefore derived from the pod cap (`limitsCpu` = 2 x `pods`, `limitsMemory` = 4Gi x `pods`, requests 250m / 512Mi x `pods`), so every pod the cap allows fits: 20 pods need 40 CPU and 80Gi of limits. Setting only `pods` rescales the rest. An explicit smaller `limitsCpu`/`limitsMemory` caps concurrency below `pods` (a `limitsCpu` of 20 admits only 10 default pods). Existing namespaces still carrying the older default (20 CPU / 40Gi of limits) are updated on the next acquire.

The over-capacity pre-check and idle-pod eviction account for CPU and memory limits and requests too, not only the pod count: a pod that would exceed any hard limit fails in about a second with `Over capacity` (naming the limit) instead of waiting out the pod-ready timeout, and idle conversation pods are evicted when CPU or memory would be exceeded.

**Server-wide run limit (separate from the quota).** The Paperclip server also limits how many Kubernetes sandbox runs run at once across all companies, because the server process itself saturates at about 20 concurrent sandbox runs (TECH-8174). Set it with `PAPERCLIP_MAX_CONCURRENT_SANDBOX_RUNS` on the server (default 20, `0` turns it off; the effective value is logged at startup). Unlike the quota, this limit **queues**: a run over it stays `queued` with a "Waiting for a sandbox slot" run event and starts as soon as a running sandbox run ends. Conversation turns go first, then companies with fewer running sandbox runs, then oldest first. The per-company quota and its `Over capacity` fail-fast are unchanged.

### Pod reuse per conversation (on by default)

On every Kubernetes sandbox environment, **turns of an ongoing agent conversation reuse one pod per conversation** with no extra configuration. The second and later turns skip pod creation and image start (assets and the bridge are still set up fresh each turn). Plain task runs, routines and timers keep a fresh pod per run, released at the end of the run. It applies to every adapter except `paperclip_runner`, which owns its own warm-session lifecycle. Pi, Claude and Hermes conversation turns all reuse, and all are scrubbed and scoped the same way.

- **Scope.** The pod is bound to one conversation (issue) and one agent, even when several conversations share an execution workspace: a different conversation or agent never receives it.
- **Idle TTL.** The server retains the lease and does not call the plugin's release between turns, so the plugin enforces the TTL: a pod with no exec for `runnerIdleTimeoutMs` (default 5 minutes) and none in flight is deleted by a 30 s reaper. The next turn finds it gone and acquires a fresh pod.
- **Scrub between turns.** When a turn resumes a pod, the plugin first kills every process except the pod's keeper (tini and its `sleep infinity`, which must stay up) and the scrub shell, deletes `<cwd>/.paperclip-runtime` (every adapter's runtime root: Hermes `hermes`, Claude `claude`, Pi `pi`, and the rest), and empties `/home/paperclip` (including `.cache`), `/tmp` and `/dev/shm`, then verifies they are empty. The pod's root filesystem is read-only, so those are its only writable places besides the workspace; the scrub is adapter-independent. The workspace files are kept (the next sync-in overwrites them; files an agent left in the workspace persist within that conversation). A pod that fails the scrub is destroyed and the turn gets a fresh pod. The bridge and its token are new each turn, and secrets arrive over exec stdin per run, so nothing from the previous run's env survives.
- **Quota.** Idle pods count against the company pod quota. Before refusing a run as over capacity, the plugin evicts the longest-idle reusable pod (idle at least 30 s, nothing in flight) in that company's namespace.
- **Limits.** The idle registry lives in the worker process: after a plugin worker restart an idle pod is forgotten until its next turn (quota eviction and the orphan reaper cover it). Agent pause does not release the pod immediately; it expires at the idle TTL. A conversation that reaches a terminal state is released by the server.

**Escape hatch (kill switch).** Set `conversationPodReuse: false` on the environment to give conversation turns a fresh pod per run like any task. It is unset by default, and unset means on. The legacy `reuseLease` / `reuseLeaseScope` / `runnerLifecycleMode` / `runnerIdleTimeoutMs` settings still work and `runnerIdleTimeoutMs` still sets the idle TTL.

### Task-scoped egress grants

Keep provider-level egress defaults narrow, then grant only the destinations a task needs through its execution workspace settings:

```json
{
  "executionWorkspaceSettings": {
    "networkEgress": {
      "allowFqdns": ["github.com", "pypi.org"],
      "allowCidrs": []
    }
  }
}
```

The provider creates a workload-owned policy selected by the task run label, so the additional destinations do not become reachable from other concurrent agent pods. Cilium mode enforces FQDNs directly. Standard NetworkPolicy mode cannot express FQDNs, so an FQDN grant permits public IPv4 TCP 80/443 for that run while excluding private, loopback, link-local, CGNAT, and multicast ranges. Network failures that look policy-related include the grant path in stderr, and the sandbox exposes the effective policy through `PAPERCLIP_NETWORK_EGRESS_*` environment variables.

## What gets created in your cluster

For each company that runs agents (created lazily on first dispatch):

```
Namespace          paperclip-{companySlug}        (PSS: restricted enforce + audit)
ServiceAccount     paperclip-tenant-sa
Role               paperclip-tenant-role          (only get pods/log)
RoleBinding        paperclip-tenant-rb
ResourceQuota      paperclip-quota                (pods, requests/limits cpu+memory)
LimitRange         paperclip-limits               (container max/min/default/defaultRequest)
NetworkPolicy      paperclip-deny-all             (deny ingress + egress baseline)
NetworkPolicy      paperclip-egress-allow         (DNS + paperclip-server callback + user CIDRs)
                   OR CiliumNetworkPolicy paperclip-egress-fqdn if egressMode=cilium
```

For each agent run (sandbox-cr backend):

```
Sandbox CR         pc-{ulid}                       (agents.x-k8s.io/v1alpha1; explicit delete on release)
Pod                pc-{ulid}-{podSuffix}           (managed by Sandbox controller; torn down on CR delete)
Secret             pc-{ulid}-env                   (owned by Sandbox CR; cascade-deleted)
```

For each agent run (job backend):

```
Job                pc-{ulid}                       (backoffLimit: 0, ttlSecondsAfterFinished from config)
Pod                pc-{ulid}-{podSuffix}           (owned by Job; cascade-deleted)
Secret             pc-{ulid}-env                   (owned by Job; cascade-deleted)
```

## Security baseline

Every agent pod is:

- non-root (`runAsUser: 1000`, `runAsGroup: 1000`, `runAsNonRoot: true`)
- drops ALL Linux capabilities, `allowPrivilegeEscalation: false`
- `readOnlyRootFilesystem: true` with explicit `emptyDir` mounts for `/workspace`, `/home/paperclip`, `/home/paperclip/.cache`, `/tmp`
- `seccompProfile: RuntimeDefault`
- Tini as PID 1 (reaps zombies, forwards signals)
- `fsGroupChangePolicy: OnRootMismatch` (fast PVC startup; openclaw-operator lesson)
- `automountServiceAccountToken: true` (for the agent shim's paperclip-server callback)

Plus per-namespace `pod-security.kubernetes.io/enforce: restricted` and a deny-all NetworkPolicy baseline with explicit egress allow-list (DNS, paperclip-server, configured FQDNs/CIDRs).

The per-run Secret carrying the bootstrap token and adapter API keys has `ownerReferences` pointing at the owning Job, so a single `kubectl delete job …` cascades cleanly to the Pod and Secret.

## Optional Kata-FC microVM isolation

For stronger isolation, install [Kata Containers](https://github.com/kata-containers/kata-containers) with the Firecracker hypervisor, then set `runtimeClassName: kata-fc` in the plugin config. Each agent pod will run inside a Firecracker microVM. Requires nested-virt-capable nodes (bare-metal or specific cloud instance types).

## Roadmap

- **Phase A (done):** `sandbox-cr` backend — multi-command exec via agent-sandbox Sandbox CRD.
- **Phase B:** Warm pool support — pre-provisioned Sandbox CRs for sub-second cold starts. The `SandboxOrchestrator` interface reserves optional `pause?`/`resume?` extension slots.
- **Phase C:** Kata-FC + snapshots — `runtimeClassName: kata-fc` with VM snapshot for fast restore.
- **Phase D:** Contribute back to agent-sandbox upstream if their Beta model diverges from our needs. The `SandboxOrchestrator` interface (`src/sandbox-orchestrator.ts`) is the clean swap point — a new implementation can be added without touching `plugin.ts` business logic.

## Lessons learned (from openclaw-operator)

This plugin adopts patterns from `openclaw-rocks/openclaw-operator`:

- Tini PID 1 (issue #471 — zombie helper processes)
- Read-only rootFS with explicit writable mounts (issue #456 — ~/.config not writable)
- Strategic merge on reconcile (issue #446 — preserve third-party annotations)
- Multi-storage-class testing (issue #448 — `local-path-provisioner` differences)
- Image version compat matrix (issue #462 — runtime deps cannot resolve after upgrade)

## Development

```bash
cd packages/plugins/sandbox-providers/kubernetes
pnpm install --ignore-workspace
pnpm test           # unit tests only (fast)
pnpm typecheck
pnpm build
```

To run the kind-cluster integration test (requires `kubectl --context kind-paperclip` and a pre-loaded alpine image; see `test/integration/end-to-end-run.test.ts`):

```bash
RUN_K8S_INTEGRATION_TESTS=1 pnpm test test/integration/end-to-end-run.test.ts
```

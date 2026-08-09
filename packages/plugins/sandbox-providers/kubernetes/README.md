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

Common optional fields:

| Field | Default | Purpose |
|---|---|---|
| `backend` | `"sandbox-cr"` | `sandbox-cr` (alpha, requires agent-sandbox controller) or `job` (stable, one-shot entrypoint). |
| `adapterType` | `"claude_local"` | One of the supported adapter types (claude_local, codex_local, gemini_local, cursor_local, opencode_local, acpx_local, pi_local). Determines runtime image + env keys + egress allow-list. |
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

Full JSON Schema in `src/manifest.ts`.

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

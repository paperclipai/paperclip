# @paperclipai/plugin-kubernetes (alpha)

First-party Paperclip sandbox-provider plugin for Kubernetes.

**Alpha:** the default backend (`sandbox-cr`) is built on `kubernetes-sigs/agent-sandbox` v1alpha1 — expect breaking changes as that CRD evolves toward Beta. Legacy `job` leases remain supported, but new `job` environment configurations are rejected because the driver advertises managed login PTY.

## Prerequisites

### For `sandbox-cr` backend (default, recommended)

1. A Kubernetes cluster running k8s 1.27+
2. [`kubernetes-sigs/agent-sandbox`](https://github.com/kubernetes-sigs/agent-sandbox) controller installed in the cluster (alpha — installs the `sandboxes.agents.x-k8s.io/v1alpha1` CRD and controller)
3. Paperclip-server running with access to the cluster (in-cluster via `inCluster: true` or external via `kubeconfig`)

### For legacy `job` backend (existing leases only)

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
| `job` (legacy only) | No | Stable API | No | Nothing beyond k8s 1.27+ |

**`sandbox-cr` (default):** Creates a `Sandbox` CR (`agents.x-k8s.io/v1alpha1`) whose controller provisions a long-lived pod running `sleep infinity`. paperclip-server execs individual commands into the running pod — this is the multi-command adapter-install pattern. When you `releaseLease`, the Sandbox CR is deleted and the controller tears down the pod.

**`job` (legacy fallback, not available for new validated environments):** Creates a `batch/v1` Job. The container entrypoint runs once and exits — no multi-command exec or login PTY. Because the driver advertises login PTY, config validation rejects `backend: job` rather than falsely offering interactive login; existing job leases can still be handled by the worker.

### Managed login PTY (sandbox-cr only)

The driver advertises `supportsLoginPty` and implements the worker open/input/stop/close hooks using a persistent Kubernetes `pods/exec` WebSocket with `tty=true`. The worker accepts only a lease acquired or resumed by this worker for the same company and environment, and maps the fixed `claude`, `codex`, and `grok` keys to `claude setup-token`, `codex login --device-auth`, and `grok login --device-auth`; caller-supplied shell commands are not executed. Each login gets a UUID-shaped session directory, and the browser code enters over PTY stdin rather than a command argument. The worker caps individual output/input chunks at 64 KiB, each session's output at 4 MiB, queued stdin at 256 KiB, and concurrent routes at 16 per worker and 4 per company; excess output or queued input stops the terminal. Route IDs are reserved during asynchronous opens, and lease release/destroy and worker shutdown close their associated terminals.

This requires a running sandbox-cr pod, an image with `/bin/sh` and the relevant CLI installed, cluster credentials authorized for `pods/exec`, and network egress to the provider's authentication endpoints (which may differ from inference API domains). Built-in `claude_local` egress includes `api.anthropic.com`, `claude.com`, and `platform.claude.com`. Local Claude Code CLI 2.1.278's `setup-token` command invokes `ConsoleOAuthFlow` with `mode: "setup-token"`; its OAuth constants specify `https://claude.com/cai/oauth/authorize` (`CLAUDE_AI_AUTHORIZE_URL`) and `https://platform.claude.com/v1/oauth/token` (`TOKEN_URL`). This is static CLI evidence, not a live login trace; redirects or version changes may require additional operator-supplied FQDNs. Custom adapter registries replace built-in FQDNs, so include the needed auth hosts there too. The `job` backend cannot host an interactive login and is rejected by environment config validation. Sessions are in-memory and do not survive a plugin-worker restart; an existing lease must be resumed on that worker before login can open. This package's tests use a scripted Exec socket, not a live apiserver or real Claude authentication.

Set `paperclipServerPodSelector` (for example `{ "app": "paperclip" }`) if the API pod accepting callbacks on TCP 3100 does not carry the default `app: paperclip-server` label. This only changes the callback target, not the agent pod selector. Selector keys and values must be valid Kubernetes label syntax; configuration validation rejects anything else. The tenant namespace is per company, so its shared `paperclip-egress-allow` / `paperclip-egress-fqdn` policy only carries the base rules (DNS and the callback) for new tenants. Each lease instead gets its own `<lease>-adapter-egress` policy, selected by the lease's `paperclip.io/run-id` label and owned by its Sandbox/Job (garbage-collected with it), holding the base rules, the adapter's default hosts (including login hosts), and the environment's `egressAllowFqdns`/`egressAllowCidrs`. Environments and adapters sharing a tenant therefore never change each other's egress, and a config change applies to every new lease; a running or resumed lease keeps the destinations it was acquired with. Existing tenants keep their previously provisioned shared egress policy unchanged (as before); delete it once no sandbox from before this change is running if its hosts should no longer apply. No cluster policy is changed by configuration validation alone.

#### Known limitation: lease expiry attestation is a stopgap, not an upstream fix

When the caller sends `requestedExpiresAt`, `onEnvironmentAcquireLease`
returns `expiresAt` computed from it (rounded down to whole seconds, capped at
24h) and bounds the `sandbox-cr` pod to the same absolute instant: the
sandbox entrypoint sleeps until that Unix time and then exits, which kills
every exec'd process, and a restart after it exits immediately. The pod also
gets `activeDeadlineSeconds` as a backstop; Kubernetes counts that from pod
start, so on its own it would let a late-starting pod outlive `expiresAt`.
Leases without a requested deadline (normal agent runs) keep a long-lived pod
and return no `expiresAt`, unchanged from before this feature. The legacy `job` backend refuses a
requested deadline instead of attesting an expiry its Job would outlive. The
hard stop uses the node clock, so large skew between the plugin worker and
the nodes shifts it. This exists
solely because Paperclip's setup-token login route fails closed
(`the acquired lease expiry does not bound the session deadline`) whenever a
sandbox-provider plugin's acquire response carries no `expiresAt` at all —
which is what this plugin did before this patch. The fix satisfies that
server-side contract; it has **not** been validated against the full range of
edge cases an official implementation would need to cover (e.g. clock skew
between plugin worker and Kubernetes nodes, or the agent-sandbox controller's
handling of a sandbox pod whose container has stopped for good). It was
written by an external operator (not the Paperclip team) as the minimum
change to unblock a self-hosted login-PTY deployment, and it has only been
exercised against a single real cluster, not Paperclip's own CI or fleet of
providers.

**This is a local, temporary fix — not an upstream contribution (yet).** If
you are reading this in a fork or a locally-built plugin, treat the
lease-expiry logic in `onEnvironmentAcquireLease` as provisional. The
Paperclip team should ideally review, generalize, and fold proper
`requestedExpiresAt` → `expiresAt` handling into the plugin (and ideally into
the SDK/provider contract itself, since every sandbox provider needs this),
the same way the `daytona` provider already does it with `setTtl`. Until an
upstream release covers this natively, treat this behavior as
implementation-specific glue and re-verify it after every Paperclip server
or plugin-SDK upgrade.

### Migrating from `job` to `sandbox-cr`

1. Install a controller compatible with the v1alpha1 Sandbox CRD (verify the controller version and CRD before making cluster changes; do not assume the latest release still serves v1alpha1).
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
| `backend` | `"sandbox-cr"` | Only `sandbox-cr` is accepted for new validated environments; legacy `job` leases remain supported. |
| `paperclipServerPodSelector` | `{ "app": "paperclip-server" }` | Pod labels on the Paperclip API callback target in the server namespace (e.g. `{ "app": "paperclip" }`). |
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

Full JSON Schema in `src/manifest.ts`.

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
NetworkPolicy      paperclip-egress-allow         (DNS + paperclip-server callback)
                   OR CiliumNetworkPolicy paperclip-egress-fqdn if egressMode=cilium
```

For each agent run (sandbox-cr backend):

```
Sandbox CR         pc-{ulid}                       (agents.x-k8s.io/v1alpha1; explicit delete on release)
Pod                pc-{ulid}-{podSuffix}           (managed by Sandbox controller; torn down on CR delete)
Secret             pc-{ulid}-env                   (owned by Sandbox CR; cascade-deleted)
NetworkPolicy      pc-{ulid}-adapter-egress        (DNS + callback + adapter/config hosts and CIDRs; owned by Sandbox CR;
                   OR CiliumNetworkPolicy           selects the run's pod)
```

For each agent run (job backend):

```
Job                pc-{ulid}                       (backoffLimit: 0, ttlSecondsAfterFinished from config)
Pod                pc-{ulid}-{podSuffix}           (owned by Job; cascade-deleted)
Secret             pc-{ulid}-env                   (owned by Job; cascade-deleted)
NetworkPolicy      pc-{ulid}-adapter-egress        (as above; owned by Job)
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

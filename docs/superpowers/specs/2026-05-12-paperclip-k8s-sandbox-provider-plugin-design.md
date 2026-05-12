# Paperclip Kubernetes Sandbox Provider Plugin — Design

**Status:** Approved 2026-05-12. Implementation plan to follow.

**Architectural foundation:** stable Kubernetes core APIs — `batch/v1` `Job`, `core/v1` `Pod`/`Secret`/`Namespace`/`ServiceAccount`/`ResourceQuota`/`LimitRange`, `rbac.authorization.k8s.io/v1` `Role`/`RoleBinding`, `networking.k8s.io/v1` `NetworkPolicy` (with optional `CiliumNetworkPolicy` for FQDN egress). No CRDs, no custom operator install, no alpha APIs.

**Why not [`kubernetes-sigs/agent-sandbox`](https://github.com/kubernetes-sigs/agent-sandbox)?** The CNCF SIG Apps `Sandbox` CRD is purpose-built for AI agents and was validated working on kind on 2026-05-12 (Ready pod in ~5s). However, it is still `v1alpha1` with open breaking-change issues (e.g. #746 proposing removal of automatic Service creation). The Beta milestone exists upstream but has no due date, no assignee — realistic timeline is months, not weeks. Building paperclip's production sandbox runtime on an alpha CRD with no compatibility guarantees is unacceptable risk. We revisit when agent-sandbox reaches Beta.

The plugin drives `Job` directly. The Job + Pod surface is GA, stable since k8s 1.0/1.21 respectively, and every cluster has it. Plugin LOC stays comparable to the agent-sandbox-backed approach (~2.5k) because we own the lifecycle code (create / watch / log / cleanup) instead of delegating it to a controller — but in exchange we get full version compatibility with k8s 1.27+ and zero CRD-install operational burden.

**Branch:** `feat/k8s-sandbox-plugin` (fresh off `origin/master`).

**Supersedes:**
- `2026-05-12-paperclip-daytona-helm-bundle-design.md` — Daytona-bundled-Helm pivot rejected after spike (10 distinct blockers, see "Why this design" below)
- `2026-05-08-paperclip-cloud-adapter-design.md` and downstream M-stack milestones (M3a, M3b). The M-stack PRs (#5556, #5558, #5565, #5576) are deferred; their hardened patterns (Cilium DSL, image allow-list, security baseline) lift into the plugin where they're the security baseline.

## Why this design

Three rounds of design exploration converged on this approach:

**1. Original M-stack (M1-M3b)** — directly wire k8s execution into `paperclip-server`. Built and works, but the verification spike on a local kind cluster found: no production path actually constructs `executionTarget.kind="kubernetes"`. Filling that gap (the M4b spec) added substantial backend wiring tightly coupled to paperclip-server's core.

**2. Daytona-bundled Helm chart** — let Daytona OSS handle the sandbox runtime, paperclip uses its existing plugin. Looked clean in theory; a 90-minute spike against the Daytona OSS Helm chart on kind surfaced 10 distinct blockers:

1. Daytona's `-k8s-*` images are amd64-only (no arm64) → Apple Silicon dev requires emulation
2. Dex is required despite docs implying it's optional → API crashes without OIDC
3. Migration ordering bug on retry installs → only namespace wipe recovers
4. OIDC issuer URL hardcoded to external hostname → unreachable from inside cluster
5. Chart's `services.api.hostAliases` value is documented but not rendered into pod spec
6. Self-signed cert untrusted by Node.js inside the API pod (needed `NODE_TLS_REJECT_UNAUTHORIZED=0`)
7. Dex doesn't support headless password grant → API keys need browser OAuth or direct DB insert
8. No runners auto-registered by helm chart → operator must register manually
9. Runner provisioning requires multi-node cluster with autoscaling → kind single-node can't satisfy
10. **Runners are Docker-in-Docker pods requiring Sysbox runtime + privileged + amd64 + systemd-inside-container** → fundamentally not "standard k8s pods"

The 10th finding made the Daytona-bundled path architecturally incompatible with paperclip's primary use case (dev on laptop with kind, production on standard managed k8s).

**3. This design — B2 plugin path on stable k8s primitives** — extract the M-stack's k8s logic into a `packages/plugins/sandbox-providers/kubernetes/` plugin that drives `batch/v1` `Job`s. Paperclip-server stops touching the k8s API directly. The plugin uses standard k8s pods (no Sysbox / DinD), works on single-node clusters, and reuses the security hardening from M3a/M3b. No CRDs and no operator install required — every cluster running k8s 1.27+ supports this out of the box.

An intermediate iteration of this design built on `kubernetes-sigs/agent-sandbox` to offload lifecycle to the upstream controller. We pivoted away because that CRD is still `v1alpha1` with active breaking-change proposals (issue #746) and no concrete Beta timeline. The cost of owning Job lifecycle directly (a few hundred LOC of poll-and-watch glue) is well worth the stability and operational simplicity of standing on GA APIs.

The plugin pattern matches the existing `daytona` and `e2b` sandbox-provider plugins in the repo (same `PluginEnvironment*` interface). Paperclip-core becomes sandbox-provider-agnostic.

**Reference points incorporated into this design:**
- `openclaw-rocks/openclaw-operator` (355 stars, v0.10.x toward 1.0) — production-hardened operator for a similar problem space. Patterns adopted: pod security hardening, deny-all NetworkPolicy baseline, per-instance RBAC, Tini PID 1, read-only rootFS, secret rotation detection. Closed-issue lessons learned: #471 (zombie helper processes), #456 (read-only rootFS writable-path design), #446 (preserve third-party annotations), #448 (multi-storage-class testing), #462 (image version compat matrix).
- M3a/M3b code — Cilium DSL, image allow-list, ensureTenant, tenant policy schema. Lifts directly into the plugin.

## Architecture

```
                  ┌────────────────────────────────┐
                  │   helm install paperclip       │
                  └────────────────────────────────┘
                                  │
              ┌───────────────────┴───────────────────┐
              │                                       │
              ▼                                       ▼
  ┌───────────────────────────┐         ┌─────────────────────────────────┐
  │  paperclip-server pod     │         │  per-tenant namespace           │
  │  + postgres (existing)    │         │  paperclip-{companySlug}        │
  │  + sandbox plugin:        │         │  - ResourceQuota                │
  │    kubernetes             │  ───►   │  - LimitRange                   │
  │                           │  k8s    │  - NetworkPolicy (deny-all)    │
  │                           │  API    │  - Egress allowlist             │
  │                           │         │  - RoleBinding (per-tenant SA)  │
  │                           │         │                                 │
  │                           │         │     ┌──────────────────────┐    │
  │                           │  ───►   │     │  per-run Job/Pod     │    │
  │                           │         │     │  - non-root          │    │
  │                           │         │     │  - drop ALL caps     │    │
  │                           │         │     │  - read-only rootFS  │    │
  │                           │         │     │  - tini PID 1        │    │
  │                           │         │     │  - ephemeral Secret  │    │
  │                           │         │     │    (env)             │    │
  │                           │         │     └──────────────────────┘    │
  └───────────────────────────┘         └─────────────────────────────────┘
              │
              │   PluginEnvironment* interface (same shape as daytona, e2b)
              ▼
  acquireLease / releaseLease / execute / probe / realizeWorkspace
```

**Standard k8s pods.** Each agent run is a `Job` with one `Pod` running the adapter's runtime image. No Docker-in-Docker. No Sysbox. No special node pools. No autoscaler required. Works on kind, EKS, GKE, AKS, k3s, k3d.

## Project structure

```
packages/
└── plugins/
    └── sandbox-providers/
        └── kubernetes/
            ├── package.json
            ├── tsconfig.json
            ├── README.md
            ├── src/
            │   ├── index.ts                    # entry, exports definePlugin(...)
            │   ├── manifest.ts                 # PaperclipPluginManifest
            │   ├── plugin.ts                   # PluginEnvironment* lifecycle hooks
            │   ├── worker.ts                   # plugin worker bootstrap
            │   ├── kube-client.ts              # k8s API client factory
            │   ├── tenant-orchestrator.ts      # ensureTenant: ns + quota + policy + RBAC
            │   ├── network-policy.ts           # Cilium DSL → CNP YAML; fallback NetworkPolicy
            │   ├── pod-spec-builder.ts         # adapter-specific pod spec assembly
            │   ├── job-orchestrator.ts        # batch/v1 Job: create / poll status / find pod / stream logs / delete / wait
            │   ├── probe-runner.ts             # transient probe Pod
            │   ├── secret-manager.ts           # ephemeral per-run Secret lifecycle
            │   ├── image-allowlist.ts          # validate target.imageOverride against allowlist
            │   ├── adapter-defaults.ts         # registry: claude_local → image + envKeys + allowFqdns + probeCommand
            │   ├── runtime-class.ts            # optional Kata-FC support
            │   └── types.ts                    # config schema (Zod)
            ├── test/
            │   ├── unit/                       # pod-spec-builder, network-policy, etc.
            │   └── integration/                # gated on RUN_K8S_INTEGRATION_TESTS=1, uses kind
            └── manifests/                      # reference YAML for ops (clusterrole, etc.)
```

Total estimated LOC: ~2,500 — most lifted/refactored from M-stack.

## Plugin config schema

```ts
// packages/plugins/sandbox-providers/kubernetes/src/types.ts
export const kubernetesProviderConfigSchema = z.object({
  // Cluster auth
  kubeconfig: z.string().optional(),               // inline kubeconfig YAML (encrypted via paperclip secrets)
  kubeconfigSecretRef: z.string().uuid().optional(), // OR ref to a paperclip secret holding the kubeconfig
  inCluster: z.boolean().default(false),           // when paperclip-server runs IN the target cluster

  // Tenant scoping
  namespacePrefix: z.string().default("paperclip-"), // tenant ns name = prefix + companySlug
  companySlug: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(), // overrides derived slug

  // Image policy
  imageRegistry: z.string().url().optional(),      // pin agent images to a registry (e.g. ghcr.io/paperclipai)
  imageAllowList: z.array(z.string()).default([]), // glob patterns. Empty = no override allowed
  imagePullSecrets: z.array(z.string()).default([]), // names of pre-created pull secrets in the tenant ns

  // Network policy
  egressAllowFqdns: z.array(z.string()).default([]), // additional FQDNs beyond per-adapter defaults
  egressAllowCidrs: z.array(z.string()).default([]), // additional CIDRs (IPs/IP ranges)
  egressMode: z.enum(["cilium", "standard"]).default("standard"), // CiliumNetworkPolicy DSL vs NetworkPolicy

  // Pod resources
  defaultResources: z.object({
    requests: z.object({ cpu: z.string(), memory: z.string() }).optional(),
    limits:   z.object({ cpu: z.string(), memory: z.string() }).optional(),
  }).optional(),

  // Runtime class (optional Kata-FC for microVM isolation)
  runtimeClassName: z.string().optional(),         // e.g. "kata-fc"

  // Workload identity (IRSA / GCP WI / Azure WI)
  serviceAccountAnnotations: z.record(z.string()).default({}),

  // Operational
  jobTtlSecondsAfterFinished: z.number().int().nonnegative().default(900), // 15 min GC
  podActivityDeadlineSec: z.number().int().positive().default(3600),       // hard ceiling per run
});
```

## Pod security baseline

Every sandbox pod (run + probe) ships with:

```yaml
spec:
  serviceAccountName: paperclip-tenant-sa       # per-namespace SA with minimal RBAC
  automountServiceAccountToken: true            # mounted for the agent shim's callback path
  runtimeClassName: <optional kata-fc>          # if configured
  restartPolicy: Never                          # one-shot
  activeDeadlineSeconds: <from podActivityDeadlineSec>
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    fsGroupChangePolicy: OnRootMismatch         # faster PVC startup (openclaw lesson)
    seccompProfile:
      type: RuntimeDefault
  initContainers:                               # workspace-init from M3a
    - name: workspace-init
      image: <agent-runtime-base:v1>
      command: ["/usr/local/bin/paperclip-workspace-init"]
      securityContext:
        readOnlyRootFilesystem: true
        allowPrivilegeEscalation: false
        capabilities: { drop: ["ALL"] }
      volumeMounts:
        - { name: workspace, mountPath: /workspace }
  containers:
    - name: agent
      image: <adapter runtime image, e.g. ghcr.io/paperclipai/agent-runtime-claude:v1>
      command: ["/usr/bin/tini", "--", "/usr/local/bin/paperclip-agent-shim"]   # tini for zombie reaping
      env:
        - { name: PAPERCLIP_RUN_ID, value: <runId> }
        - { name: PAPERCLIP_API_URL, value: <cluster URL or external> }
        - { name: PAPERCLIP_BOOTSTRAP_TOKEN, valueFrom: { secretKeyRef: { name: <per-run-secret>, key: BOOTSTRAP_TOKEN } } }
      envFrom:
        - { secretRef: { name: <per-run-secret> } }   # adapter env (ANTHROPIC_API_KEY etc.)
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        readOnlyRootFilesystem: true
        allowPrivilegeEscalation: false
        capabilities: { drop: ["ALL"] }
      volumeMounts:
        - { name: workspace, mountPath: /workspace }
        - { name: home,      mountPath: /home/paperclip }   # adapter writable home (e.g. claude session)
        - { name: tmp,       mountPath: /tmp }
        - { name: cache,     mountPath: /home/paperclip/.cache }
      resources:
        requests: { cpu: 250m, memory: 512Mi }
        limits:   { cpu: 2,    memory: 4Gi, ephemeral-storage: 8Gi }
  volumes:
    - name: workspace
      emptyDir: { sizeLimit: 8Gi }
    - name: home
      emptyDir: { sizeLimit: 1Gi }
    - name: tmp
      emptyDir: { sizeLimit: 2Gi }
    - name: cache
      emptyDir: { sizeLimit: 1Gi }
```

Writable paths are explicitly listed as `emptyDir` mounts; rootFS stays read-only. This is the openclaw-operator pattern after their issue #456 (acpx embedded runtime blocked on read-only rootFS without proper writable mounts).

## Tenant namespace setup (ensureTenant)

Lazy on first dispatch. Materializes the per-company namespace + policies:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: paperclip-{companySlug}
  labels:
    paperclip.io/company-id: {companyUuid}
    paperclip.io/managed-by: paperclip-k8s-plugin
    pod-security.kubernetes.io/enforce: restricted     # PSS
    pod-security.kubernetes.io/audit: restricted
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: paperclip-tenant-sa
  namespace: paperclip-{companySlug}
  annotations:
    {{ serviceAccountAnnotations | toYaml }}            # IRSA / GCP WI hooks
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: paperclip-tenant-role
  namespace: paperclip-{companySlug}
rules:
  # Minimal — agent shim needs almost nothing
  - apiGroups: [""]
    resources: ["pods/log"]    # for own pod's logs
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: paperclip-tenant-rb
  namespace: paperclip-{companySlug}
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: paperclip-tenant-role }
subjects:
  - kind: ServiceAccount
    name: paperclip-tenant-sa
    namespace: paperclip-{companySlug}
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: paperclip-quota
  namespace: paperclip-{companySlug}
spec:
  hard:
    pods: "20"                # cap concurrent runs per tenant
    requests.cpu: "5"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 80Gi
    requests.ephemeral-storage: 40Gi
    limits.ephemeral-storage: 80Gi
---
apiVersion: v1
kind: LimitRange
metadata:
  name: paperclip-limits
  namespace: paperclip-{companySlug}
spec:
  limits:
    - type: Container
      max:        { cpu: "4",  memory: "8Gi", ephemeral-storage: "16Gi" }
      min:        { cpu: "100m", memory: "128Mi" }
      default:    { cpu: "1",  memory: "2Gi", ephemeral-storage: "8Gi" }
      defaultRequest: { cpu: "250m", memory: "512Mi", ephemeral-storage: "1Gi" }
---
# Deny-all NetworkPolicy baseline
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: paperclip-deny-all
  namespace: paperclip-{companySlug}
spec:
  podSelector: {}                  # all pods
  policyTypes: [Ingress, Egress]
  # No ingress rules → all blocked
  # No egress rules → all blocked
---
# Egress allow-list (built from adapter-defaults.allowFqdns + config.egressAllowFqdns/Cidrs)
# Standard NetworkPolicy variant (CIDRs only):
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: paperclip-egress-allow
  namespace: paperclip-{companySlug}
spec:
  podSelector:
    matchLabels: { paperclip.io/role: agent }
  policyTypes: [Egress]
  egress:
    - to:
        - ipBlock: { cidr: 169.254.169.254/32, except: [] }   # block IMDS (cloud metadata)
      ports: [{ protocol: TCP, port: 0 }]                      # actually deny — we use except above; example
    # Allow DNS to kube-dns
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
          podSelector: { matchLabels: { k8s-app: kube-dns } }
      ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
    # Allow back-to-paperclip (for callbacks)
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: paperclip } }
          podSelector: { matchLabels: { app: paperclip-server } }
      ports: [{ protocol: TCP, port: 3100 }]
    # CIDR-based egress (e.g. for HTTPS to known IPs — limited utility for SaaS APIs)
    {{- range $.config.egressAllowCidrs }}
    - to:
        - ipBlock: { cidr: {{ . }} }
    {{- end }}
```

For Cilium clusters, `egressMode: cilium` switches to `CiliumNetworkPolicy` with FQDN-based egress (e.g. `api.anthropic.com` matched by Cilium's DNS proxy). The DSL was built in M3a; reuse it.

## Per-run pod assembly

```ts
// packages/plugins/sandbox-providers/kubernetes/src/pod-spec-builder.ts
function buildJobSpec(input: BuildJobInput): k8s.Job {
  const adapterDefaults = getAdapterDefaults(input.adapterType);
  const image = resolveImage(input.target, adapterDefaults, input.config);
  const env = mergeEnv(input.env, adapterDefaults.envKeys);
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `r-${input.runUlid}`,
      namespace: input.namespace,
      labels: {
        "paperclip.io/role": "agent",
        "paperclip.io/run-id": input.runId,
        "paperclip.io/agent-id": input.agentId,
        "paperclip.io/adapter": input.adapterType,
      },
    },
    spec: {
      ttlSecondsAfterFinished: input.config.jobTtlSecondsAfterFinished ?? 900,
      activeDeadlineSeconds: input.config.podActivityDeadlineSec ?? 3600,
      backoffLimit: 0,                                    // no retries — paperclip handles
      template: {
        metadata: {
          labels: { ... },
          annotations: {
            // Preserve any operator-foreign annotations on Job updates — strategic merge
          },
        },
        spec: buildPodSpec(input),                        // the security-hardened spec from above
      },
    },
  };
}
```

**Image resolution** — `resolveImage` enforces `imageAllowList`:

```ts
function resolveImage(
  target: { imageOverride?: string | null },
  adapterDefaults: { runtimeImage: string },
  config: KubernetesProviderConfig,
): string {
  if (target.imageOverride) {
    if (!config.imageAllowList.some(p => globMatch(p, target.imageOverride))) {
      throw new Error(`Image override "${target.imageOverride}" not in allowlist`);
    }
    return target.imageOverride;
  }
  // Default to adapter's image, possibly rewritten to use configured registry
  if (config.imageRegistry) {
    return rewriteRegistry(adapterDefaults.runtimeImage, config.imageRegistry);
  }
  return adapterDefaults.runtimeImage;
}
```

## Per-run secret + env injection

```ts
// secret-manager.ts
async function createPerRunSecret(input): Promise<{ secretName: string; cleanup: () => Promise<void> }> {
  const name = `r-${input.runUlid}-env`;
  await k8sApi.createSecret({
    metadata: {
      name,
      namespace: input.namespace,
      labels: { "paperclip.io/run-id": input.runId, "paperclip.io/managed-by": "paperclip-k8s-plugin" },
      ownerReferences: [{
        apiVersion: "batch/v1",
        kind: "Job",
        name: `r-${input.runUlid}`,
        uid: input.jobUid,
        controller: true,
        blockOwnerDeletion: true,
      }],
    },
    stringData: {
      BOOTSTRAP_TOKEN: input.bootstrapToken,
      ...input.adapterEnv,                                 // ANTHROPIC_API_KEY etc.
    },
    type: "Opaque",
  });
  // Owner reference ensures the Secret is GC'd when the Job is deleted.
  return { secretName: name, cleanup: async () => {} };    // GC handles it
}
```

Secrets are owned by the Job, so they cascade-delete on Job cleanup. No manual cleanup needed.

## PluginEnvironment* lifecycle

The plugin implements paperclip's existing `PluginEnvironment*` interface (same as `daytona` and `e2b` plugins):

```ts
// plugin.ts
definePlugin({
  manifest,
  async validateConfig({ config }) {
    return kubernetesProviderConfigSchema.safeParse(config);
  },
  async acquireLease({ config, env, runtime, agent, runId }): Promise<PluginEnvironmentLease> {
    const client = await getKubeClient(config);
    const namespace = await ensureTenant(client, config, agent);
    const bootstrapToken = await mintBootstrapToken({ runId, agentId: agent.id, companyId: agent.companyId });
    const jobName = `r-${newRunUlidDns()}`;
    await createPerRunSecret(client, { namespace, runId, bootstrapToken, adapterEnv: env, jobUid: null });
    const job = await client.createJob(buildJobSpec({ namespace, jobName, adapterType: agent.adapterType, ... }));
    return {
      id: jobName,
      metadata: { namespace, jobName, podName: null, phase: "Pending" },
    };
  },
  async execute({ lease, command, args, env, stdin, onLog }): Promise<PluginEnvironmentExecuteResult> {
    const client = await getKubeClient(config);
    const podName = await waitForPod(client, lease.metadata.namespace, lease.id);
    // Stream logs via watch API
    await client.streamPodLogs(podName, async (stream, chunk) => {
      await onLog(stream, chunk);
    });
    const finalStatus = await waitForJobComplete(client, lease.metadata.namespace, lease.id);
    return { exitCode: finalStatus.exitCode, signal: null, timedOut: finalStatus.timedOut };
  },
  async releaseLease({ lease }) {
    const client = await getKubeClient(config);
    // Delete the Job — Secret cascade-deletes via owner reference
    await client.deleteJob(lease.metadata.namespace, lease.id, { propagationPolicy: "Background" });
  },
  async probe({ config }) {
    const client = await getKubeClient(config);
    return { ok: await client.canList("pods", "paperclip-{slug-or-default}") };
  },
  async realizeWorkspace({ lease, files }) {
    // Workspace is created by the workspace-init container during pod startup
    // realizeWorkspace updates the ConfigMap that workspace-init reads
    // ...same pattern as M3a workspace-strategy
  },
});
```

## Best-practice checklist (from openclaw-operator lessons)

- [x] **Tini PID 1** — `command: ["/usr/bin/tini", "--", "/usr/local/bin/paperclip-agent-shim"]` (lesson: openclaw #471 zombie helper processes)
- [x] **Read-only rootFS with explicit writable mounts** — all writable paths are `emptyDir` (lesson: openclaw #456)
- [x] **Strategic merge on resource updates** — `apply` instead of `replace` for managed resources, preserving foreign annotations (lesson: openclaw #446)
- [x] **Multi-storage-class testing** — integration tests cover `standard` + `local-path` + `hostpath` storage classes (lesson: openclaw #448)
- [x] **Version compat matrix** — paperclip-server ↔ adapter image semver matrix, documented in `compatibility.md` (lesson: openclaw #462)
- [x] **Secret rotation detection** — `envFrom` re-read on Pod creation (per-run pods recreate every run; long-lived pods aren't a concern)
- [x] **Pod Security Standards enforcement** — namespace label `pod-security.kubernetes.io/enforce: restricted`
- [x] **NetworkPolicy deny-all baseline** — every tenant ns gets deny-all + explicit allow-list
- [x] **No cluster-wide RBAC on sandbox SAs** — only per-namespace Role/RoleBinding
- [x] **fsGroupChangePolicy: OnRootMismatch** — fast PVC startup (openclaw v0.10.0)
- [x] **IRSA / Workload Identity annotations** — `serviceAccountAnnotations` in config
- [x] **TTLSecondsAfterFinished** — Jobs auto-GC after 15 min (configurable)
- [x] **Custom CA bundle support** — `extraVolumes` + `extraVolumeMounts` config keys (openclaw v0.10.0 pattern)
- [ ] **Topology spread constraints** — deferred, openclaw v0.11.0 scope; revisit if multi-AZ needed
- [ ] **Operator SDK scorecard equivalent** — N/A (we're a plugin, not an operator)

## Failure modes and recovery

| Code | Trigger | User-facing message | Recovery |
|---|---|---|---|
| `cluster_unreachable` | k8s API call times out / TLS fails | "Couldn't reach cluster API. Check `kubeconfig` / `inCluster` config." | Operator fixes auth |
| `tenant_quota_exceeded` | ResourceQuota rejects pod creation | "Namespace `{ns}` is over its ResourceQuota: pods=N/M." | Operator raises quota or waits for runs to GC |
| `image_pull_failed` | ImagePullBackOff on agent pod | "Couldn't pull `{image}` — check `imageRegistry` and `imagePullSecrets`." | Operator fixes registry config |
| `image_not_in_allowlist` | `target.imageOverride` rejected by `imageAllowList` | "Image `{image}` not in cluster's allowlist." | Operator adds to allowlist or uses default image |
| `network_policy_blocks` | Pod can't reach Anthropic API (or whichever) | "Egress blocked. Check `egressAllowFqdns` includes provider domains." | Operator adds FQDN |
| `pod_oom_killed` | Pod exceeded memory limits | "Pod OOM-killed at `{memory}`. Raise `defaultResources.limits.memory`." | Operator raises limits |
| `pod_active_deadline_exceeded` | Pod ran past `podActivityDeadlineSec` | "Run exceeded `{seconds}s` deadline." | Operator raises deadline or splits work |
| `pod_failed_health_probe` | Liveness probe fails repeatedly | Forwards probe details | Investigate logs |

All errors surface through `PluginEnvironmentExecuteResult.exitCode` + a structured `metadata.error` field that paperclip's existing run-result UI already renders.

## Migration from M-stack

The M-stack PRs (M1-M3b) are not merged. This plugin design replaces them. **No live-system migration is required.**

For operators who experimented with the M-stack branches privately, the migration is:

1. `helm install paperclip` (with no M-stack deployment configuration)
2. Install the kubernetes sandbox plugin: `paperclipai plugin install @paperclipai/plugin-kubernetes`
3. Create a `sandbox` environment with `provider: kubernetes` and the kubeconfig
4. Re-bind agents to the new environment
5. Existing `cluster_connections` rows in their DB are orphaned but not harmful — they can be deleted manually or left

## Testing strategy

### Unit tests

- `pod-spec-builder.ts` — every security baseline check (non-root, drop ALL, readOnlyRootFilesystem, tini command, env merge precedence)
- `network-policy.ts` — DSL → CNP and DSL → NetworkPolicy YAML correctness; egress-allow-list expansion
- `image-allowlist.ts` — glob match correctness, edge cases (empty list, wildcard `*`)
- `tenant-orchestrator.ts` — ensure-tenant idempotency, RBAC scoping
- `kubernetesProviderConfigSchema` — Zod validation: missing kubeconfig + inCluster=false rejected, etc.

### Integration tests (kind-gated, `RUN_K8S_INTEGRATION_TESTS=1`)

- **Fresh tenant provisioning** — verify all 6 resource kinds (ns, sa, role, rb, quota, limitRange, networkpolicy) are created with correct labels and security baseline.
- **End-to-end claude_local run** — submit a one-turn task, verify pod starts, command runs, logs stream, exit code propagates, pod GCs after TTL.
- **Lazy ensureTenant idempotency** — second run for same company reuses the namespace + binding.
- **Image-allowlist enforcement** — `target.imageOverride` outside the allowlist gets rejected with `image_not_in_allowlist`.
- **ResourceQuota enforcement** — submit `pods + 1` concurrent runs, verify the over-quota one fails with `tenant_quota_exceeded`.
- **Egress NetworkPolicy** — submit a run, verify the pod can reach the allowed FQDN, can't reach an arbitrary unallowed IP.
- **Cleanup correctness** — delete the Job, verify Secret + Pod cascade-delete via owner ref. No orphaned ConfigMaps or PVCs.
- **Multi-storage-class compatibility** — run integration tests against `standard` (local-path-provisioner) and `hostpath`. Skip volume-related tests where storage class doesn't support PVC.

### E2E test (Playwright, existing suite)

One new scenario: configure a kubernetes sandbox environment in the UI, bind a CEO agent, trigger a run, verify the resulting run appears in the run viewer with logs streamed.

## Out of scope (deferred)

| Item | Why deferred |
|---|---|
| Snapshot/persistence (workspace state survives across runs) | Daytona offers this but paperclip's run model is ephemeral. Revisit if product requires "warm agents." |
| SSH gateway to running sandboxes | Useful for debugging. Add as a separate feature in M5+; can be implemented via `kubectl exec` proxy in paperclip-server. |
| Topology spread constraints | Multi-AZ scheduling. Add when first multi-AZ deployment appears. |
| Operator-style CRD (`PaperclipAgentRun`) | The plugin pattern is sufficient. Revisit if GitOps-driven agent management becomes a real user need. |
| Helm chart for paperclip itself | Separate spec. This plugin lives inside paperclip and ships via the standard plugin install path. |
| Auto-arm64 multi-arch image builds for adapter runtime images | Separate CI work — paperclip's release pipeline must publish multi-arch tags for the 7 adapter images. |
| Multi-cluster scheduling | One cluster per `sandbox` environment is V1. Cross-cluster scheduling = M5+. |
| Built-in observability stack | Operators bring their own Prometheus/Grafana. Plugin exposes the pod labels needed for ServiceMonitor. |

## Open questions for review

1. **Adapter image registry default** — should the plugin default to `ghcr.io/paperclipai/agent-runtime-*:v1` or require operators to specify? *Recommendation: default to the public registry, allow override via `imageRegistry` config.*
2. **CRD upgrade path** — if we later want a CRD (for `kubectl get paperclipruns` UX), can the plugin migrate cleanly? *Recommendation: the plugin's resource labels (`paperclip.io/run-id`, etc.) already provide a `kubectl get pods -l paperclip.io/run-id=...` UX; defer CRDs until there's a real need.*
3. **Probe scope** — should probe just confirm cluster reachability (cheap, fast) or also dispatch a transient pod (slower, more thorough)? *Recommendation: cheap by default (`canList` pods in the tenant ns), with optional thorough probe via env config.*

## Update 2026-05-12 (post-smoke-test pivot)

**Summary:** Smoke testing the initial `batch/v1` Job backend against the local kind cluster revealed a fundamental architectural mismatch: paperclip-server's adapter-install pattern requires N exec calls into a long-lived workload (install deps, configure, run agent), not a single one-shot entrypoint. The Job backend cannot support this pattern — each Job runs one entrypoint and exits.

### Problem: Job model ≠ adapter-install pattern

The adapter-install flow sends multiple sequential commands to the sandbox environment (e.g. `pip install adapter-deps`, then `paperclip-agent-shim start`). With the Job backend, the container entrypoint is baked into the Job spec at creation time. There is no mechanism to exec additional commands into a completed or running one-shot Job without redesigning the Job's entrypoint to behave like a daemon — at which point you've effectively reimplemented a Sandbox controller.

### Pivot: primary backend = `kubernetes-sigs/agent-sandbox` Sandbox CRD

The `kubernetes-sigs/agent-sandbox` CRD (`sandboxes.agents.x-k8s.io/v1alpha1`) was already validated working on the kind cluster during the initial spike (Ready pod in ~5s). It provides exactly what we need: a long-lived pod with `sleep infinity` entrypoint managed by a controller, into which paperclip-server can exec commands via the Kubernetes exec API.

We accept the alpha-stage risk, mitigated by:

1. **Clear "alpha" labeling** — plugin `displayName` is "Kubernetes Sandbox (alpha)", version bumped to `0.1.0-alpha.1`, README and manifest description lead with ALPHA callout.
2. **Stable fallback** — `backend: "job"` config option retains the original `batch/v1` Job behavior for operators who cannot install agent-sandbox or need strictly stable APIs.
3. **Clean interface seam** — `SandboxOrchestrator` interface in `src/sandbox-orchestrator.ts` isolates both backends. Swapping backends (or adding a third) is a one-import change in `plugin.ts`.

### New files added

- `src/sandbox-cr-builder.ts` — builds the Sandbox CR manifest (same security baseline as `pod-spec-builder.ts`, entrypoint is `sleep infinity` via Tini).
- `src/sandbox-cr-orchestrator.ts` — `SandboxOrchestrator` implementation using `CustomObjectsApi`. Key semantic change: `waitForCompletion` means "wait until pod is Ready to exec" (phase=Ready), NOT "wait until workload finishes".
- `src/pod-exec.ts` — `execInPod()` wraps `@kubernetes/client-node`'s `Exec` class for WebSocket-based exec with exit code extraction from `V1Status.details.causes`.

### Changed semantics

- `onEnvironmentExecute` for `sandbox-cr` backend: resolves pod name from Sandbox CR, waits for Ready, calls `execInPod(kc, ns, podName, "agent", ["/bin/sh", "-lc", command])`. Returns `{exitCode, stdout, stderr}` directly from exec result.
- `onEnvironmentExecute` for `job` backend: unchanged (wait for Job completion, scrape logs).
- `onEnvironmentAcquireLease`: picks orchestrator and manifest builder based on `config.backend`. Secret `ownerRef` is Sandbox CR for sandbox-cr mode, Job for job mode.
- `onEnvironmentReleaseLease`: reads `leaseMetadata.backend` to route to the correct orchestrator for release.

### Updated roadmap

- **Phase A (this PR):** `sandbox-cr` backend with multi-command exec via agent-sandbox CRD.
- **Phase B:** Warm pool — pre-provisioned Sandbox CRs for sub-second cold starts.
- **Phase C:** Kata-FC + VM snapshots for stronger isolation and fast restore.
- **Phase D:** Contribute back to agent-sandbox upstream if their Beta model diverges from our exec-into-running-pod needs.

### Why we accepted alpha risk now

The original "wait for Beta" position assumed the Job backend could tide us over. The smoke test disproved that assumption: the Job backend fundamentally cannot serve the adapter-install pattern. The choice is now "alpha CRD with exec" vs "no functional product" — not "stable Job" vs "alpha CRD". Given that framing, accepting the alpha CRD with the mitigations above is the correct call.

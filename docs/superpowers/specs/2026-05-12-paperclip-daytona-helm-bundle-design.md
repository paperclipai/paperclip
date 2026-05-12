# Paperclip Helm Chart with Bundled Daytona Sandbox Runtime

**Status:** Approved 2026-05-12. Implementation plan to follow.

**Branch:** `feat/daytona-helm-bundle` (fresh off `origin/master`).

**Supersedes:** `docs/superpowers/specs/2026-05-08-paperclip-cloud-adapter-design.md` and downstream M-stack milestones (M3a, M3b). The M-stack PRs (#5556 M1, #5558 M2, #5565 M3a, #5576 M3b) are deferred / will be closed once this path lands and proves out.

## Why this exists

End-to-end verification of M3b in a local `kind` cluster surfaced that no production code path in the M-stack actually dispatches an agent run to Kubernetes — the wiring from agent → `executionTarget.kind="kubernetes"` is missing. The first instinct was to fill the gap with an in-tree M4b PR that extends `ENVIRONMENT_DRIVERS` with `"kubernetes"`, adds an environment-config schema, wraps the dispatcher with a lazy `ensureTenant`, and rebuilds the onboarding wizard around in-cluster auto-detection. The design for that path was drafted to a complete spec (deleted; superseded by this document).

Two observations during that design exercise made the in-tree path look like the wrong fit:

1. **Most of what M-stack does already exists in Daytona.** The Daytona OSS product, deployed via its official Helm chart, ships namespace-per-tenant isolation, ResourceQuota + LimitRange, NetworkPolicies, image governance, a container registry (Harbor), an OIDC provider (Dex), workspace persistence + snapshots, SSH access to running sandboxes, and a TypeScript SDK. The M-stack reinvents the first half of that list and doesn't address the second half.
2. **Paperclip already has a Daytona plugin** at `packages/plugins/sandbox-providers/daytona/` (~1.2k LOC, tested) that uses `@daytonaio/sdk` and supports any Daytona endpoint via an `apiUrl` config field. The plugin works against Daytona Cloud today; Daytona OSS exposes the same API.

The realistic alternative the field offers is **E2B** (Firecracker microVMs, stronger isolation). E2B's self-hosting deploys on Nomad over AWS/GCP only — intentionally not Kubernetes, because Firecracker needs direct hardware access (KVM, `/dev/kvm`, nested virtualization). Building a k8s-compatible E2B is multi-engineer-quarter work, not a Helm chart. The closest k8s-native equivalent to Firecracker-grade isolation is **Daytona + Kata Containers** — Kata is a CNCF project that runs each pod as a microVM, optionally on Firecracker; Daytona supports Kata as a runtime class. That stack achieves the security upgrade through configuration, not new code.

The decision: ship Paperclip as a Helm chart that bundles Daytona as a dependency. Use Daytona's OSS Helm chart for the sandbox runtime. Wire Paperclip to point at it automatically. Close the M-stack once the new path is validated.

## The new approach in one diagram

```
                  ┌────────────────────────────────────────┐
                  │           helm install paperclip       │
                  └────────────────────────────────────────┘
                                     │
              ┌──────────────────────┴──────────────────────┐
              │                                             │
              ▼                                             ▼
  ┌─────────────────────────┐                  ┌─────────────────────────┐
  │  paperclip-server pod   │                  │  daytona-* pods         │
  │  + postgres (existing)  │                  │  (subchart dependency)  │
  │  + sandbox plugin:      │                  │   api, proxy, ssh-gw,   │
  │    daytona              │                  │   postgres, redis,      │
  │  + user_provider_keys   │                  │   harbor, dex, runner   │
  │  + company secrets      │                  │                         │
  └─────────────────────────┘                  └─────────────────────────┘
              │                                             ▲
              │   daytona apiUrl (cluster DNS)              │
              │   daytona apiKey (post-install hook)        │
              └─────────────────────────────────────────────┘
              │                                             │
              │            Agent run dispatched             │
              ▼                                             ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │                  Daytona-managed sandbox pod                        │
  │  - claude / codex / gemini / opencode CLI                           │
  │  - paperclip-agent-shim                                             │
  │  - ANTHROPIC_API_KEY (from company secret resolved by plugin)       │
  │  - PAPERCLIP_API_URL callback (cluster DNS)                         │
  └─────────────────────────────────────────────────────────────────────┘
```

**Paperclip-server code changes: essentially none for the dispatch path.** The existing `packages/plugins/sandbox-providers/daytona/` plugin already handles `acquireLease` / `releaseLease` / `execute` / `probe` / `realizeWorkspace`. What this PR ships is:

1. The Helm chart itself (`charts/paperclip/`) with Daytona as a subchart dependency.
2. A new server-side onboarding step that detects the bundled Daytona instance and auto-creates an environment + agent binding.
3. User-scoped provider-key storage (the `user_provider_keys` table from the earlier design — that decision survives).
4. Documentation: install guide, values reference, debugging guide.

## 1. Helm chart structure

### 1.1 Chart layout

```
charts/
└── paperclip/
    ├── Chart.yaml
    ├── values.yaml
    ├── values.kata.yaml          # optional override for Kata-FC isolation
    ├── README.md
    └── templates/
        ├── _helpers.tpl
        ├── paperclip-server-deployment.yaml
        ├── paperclip-server-service.yaml
        ├── paperclip-server-ingress.yaml
        ├── postgres-deployment.yaml          # bundled lightweight postgres
        ├── postgres-pvc.yaml
        ├── postgres-service.yaml
        ├── daytona-bridge-secret.yaml        # post-install hook generates daytona api key
        ├── daytona-bridge-hook.yaml          # job that mints the api key against daytona
        └── tests/
            └── test-paperclip-ready.yaml
```

### 1.2 `Chart.yaml`

```yaml
apiVersion: v2
name: paperclip
description: Paperclip agent platform with bundled Daytona sandbox runtime.
type: application
version: 0.1.0
appVersion: "v2026.512.0"   # tracks paperclip-server release line

dependencies:
  - name: daytona
    version: "~1.5.0"        # tightest range that exercises supported feature set
    repository: "https://charts.daytona.io"
    condition: daytona.enabled

  - name: postgresql
    version: "~15.5.0"
    repository: "oci://registry-1.docker.io/bitnamicharts"
    condition: postgresql.enabled
```

Both `daytona` and `postgresql` are `condition`-gated so operators with external Postgres or external Daytona instances can disable the subcharts and provide their own.

### 1.3 Default `values.yaml`

```yaml
# Paperclip server configuration
paperclip:
  image:
    repository: ghcr.io/paperclipai/paperclip-server
    tag: ""                              # defaults to .Chart.AppVersion
  replicaCount: 1
  resources:
    requests: { cpu: 250m, memory: 512Mi }
    limits:   { memory: 2Gi }
  service:
    type: ClusterIP
    port: 3100
  ingress:
    enabled: true
    hostname: paperclip.local            # operator overrides
    className: nginx
    tls: true
    selfSigned: true                     # for kind / local
  env:
    PAPERCLIP_DEPLOYMENT_MODE: "authenticated"
    PAPERCLIP_DEPLOYMENT_EXPOSURE: "private"
    BETTER_AUTH_SECRET: ""               # required; helm errors if empty
    PAPERCLIP_RUN_JWT_SECRET: ""         # required; helm errors if empty
  # sandbox provider — what backs agent execution
  sandbox:
    provider: "daytona"                  # one of: daytona | local | e2b
    # When provider=daytona, the chart wires apiUrl/apiKey from the bundled
    # subchart unless overridden here:
    daytona:
      apiUrl: ""                         # auto-derived from bundled chart
      apiKey: ""                         # auto-generated by post-install hook
      target: ""                         # optional region/target
      snapshot: ""                       # optional default snapshot name
      reuseLease: true                   # workspace reuse across runs

# Bundled Daytona (subchart)
daytona:
  enabled: true
  baseDomain: "daytona.local"
  # The chart's defaults are reasonable; key overrides for local/kind:
  services:
    api:
      ingress:
        selfSigned: true
  # Disable Harbor by default — Paperclip uses public ghcr.io agent images
  harbor:
    enabled: false
  # Disable PgAdmin — operator UI, not needed for headless use
  pgadmin4:
    enabled: false
  # Disable Dex — Daytona's auth UI competes with Paperclip's Better Auth;
  # we use the API key flow, not Daytona's UI sign-in
  dex:
    enabled: false

# Bundled PostgreSQL (subchart) for paperclip-server's own DB
postgresql:
  enabled: true
  auth:
    username: paperclip
    password: ""                         # required; helm errors if empty
    database: paperclip
  primary:
    persistence:
      enabled: true
      size: 5Gi
```

### 1.4 `values.kata.yaml` — opt-in microVM isolation

```yaml
# Apply with: helm install paperclip paperclip/paperclip -f values.kata.yaml
# Prerequisite: cluster has Kata Containers installed and a kata-fc RuntimeClass
daytona:
  runners:
    runtimeClass: "kata-fc"
    nodeSelector:
      paperclip.io/kata-capable: "true"
```

Document the prerequisite — operator must install Kata separately (`kata-deploy/kata-deploy` chart) and label their bare-metal / nested-virt nodes accordingly. For laptop / standard k8s, omit this file and run Daytona-default OCI containers.

### 1.5 The `daytona-bridge-hook` job

A `helm.sh/hook: post-install,post-upgrade` Job that:

1. Waits for the Daytona API to be ready (`/health` endpoint).
2. Authenticates against Daytona (the bundled OSS install creates a default admin via a `daytona-admin-credentials` secret the chart writes).
3. Mints an API key for Paperclip's use via Daytona's `/api/apiKeys` endpoint.
4. Writes the API key into the `paperclip-daytona-bridge` Secret consumed by the paperclip-server Deployment.
5. Sets `paperclip.sandbox.daytona.apiUrl = http://daytona-api.{{ .Release.Namespace }}.svc:3000` in a ConfigMap the server reads on boot.

On `helm uninstall`, a paired `pre-delete` hook revokes the API key so the bundle leaves no orphan auth state.

### 1.6 Helm chart tests (`helm test`)

Three smoke tests bundled in `templates/tests/`:

1. **paperclip-ready** — pod that curls `http://paperclip-server:3100/api/health` and exits non-zero on failure.
2. **daytona-reachable** — pod that uses `curl` to confirm `daytona-api:3000/health` responds.
3. **bridge-secret-populated** — pod that checks the `paperclip-daytona-bridge` Secret has both `apiUrl` and `apiKey` keys non-empty.

## 2. Server-side onboarding wiring

The chart sets `PAPERCLIP_SANDBOX_PROVIDER=daytona` and writes the bridge config. Onboarding logic gets one new check:

### 2.1 Boot-time auto-registration

In `server/src/index.ts` startup, after the existing onboarding-state init:

```ts
async function maybeRegisterBundledDaytonaEnvironment(deps: {
  envService: EnvironmentService;
  companiesService: CompaniesService;
}): Promise<void> {
  const sandboxProvider = process.env.PAPERCLIP_SANDBOX_PROVIDER ?? "";
  const daytonaApiUrl = process.env.PAPERCLIP_DAYTONA_API_URL ?? "";
  const daytonaApiKey = process.env.PAPERCLIP_DAYTONA_API_KEY ?? "";

  if (sandboxProvider !== "daytona" || !daytonaApiUrl || !daytonaApiKey) {
    return;
  }
  // For each existing company that doesn't yet have a daytona environment, create one.
  // For new companies, the company-creation flow will pick this up via the wizard.
  for (const company of await deps.companiesService.listAll()) {
    const existing = await deps.envService.findByCompanyAndDriver(company.id, "sandbox", "daytona");
    if (existing) continue;
    await deps.envService.create({
      companyId: company.id,
      name: "Daytona (bundled)",
      driver: "sandbox",
      config: {
        provider: "daytona",
        apiUrl: daytonaApiUrl,
        apiKey: { ref: "system:daytona.api-key" },
        reuseLease: true,
      },
    });
  }
}
```

The `system:daytona.api-key` secret ref is materialized by a server-side resolver that reads `PAPERCLIP_DAYTONA_API_KEY` from process.env at runtime — the same way other system-level secrets work today. The key never reaches the database; it's resolved per-run.

### 2.2 Onboarding wizard step

The existing onboarding wizard (`ui/src/routes/onboarding/...`) gets one extra step before agent creation, only rendered when `process.env.PAPERCLIP_SANDBOX_PROVIDER === "daytona"`:

```
┌──────────────────────────────────────────────────────────┐
│ ✓ Bundled sandbox runtime detected                       │
│                                                          │
│ This Paperclip instance ships with Daytona as the agent  │
│ sandbox runtime. New agents will run in isolated Daytona │
│ sandboxes by default.                                    │
│                                                          │
│ Switch this in Settings → Sandbox Providers anytime.     │
│                                                          │
│                              [ Continue ]               │
└──────────────────────────────────────────────────────────┘
```

When the CEO is created, the wizard binds it to the bundled "Daytona (bundled)" environment auto-created in 2.1.

### 2.3 Settings → Sandbox Providers (post-onboarding)

A new Settings page (`ui/src/routes/settings/sandbox-providers.tsx`, ~150 lines) listing:

- The bundled Daytona endpoint (read-only when bundled — managed by Helm)
- Any user-added sandbox providers (E2B, external Daytona, custom plugin)
- Per-company default selection

Operators who want to point at an external Daytona, or use E2B Cloud, configure it here.

## 3. Provider credentials — three-layer model (carried from earlier design)

Unchanged from the earlier design exercise. The model survives the pivot:

```
process.env  →  user_provider_keys  →  secrets (company)  →  agent.adapter_config.env
(pre-fill,      (pre-fill, per-user,   (runtime, per-       (per-agent override)
first-run)      encrypted)              company, encrypted)
```

### 3.1 New table

```sql
CREATE TABLE user_provider_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_name    text NOT NULL,
  value       text NOT NULL,                  -- encrypted via existing secret provider
  created_at  timestamp with time zone NOT NULL DEFAULT now(),
  updated_at  timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (user_id, key_name)
);
CREATE INDEX user_provider_keys_user_id_idx ON user_provider_keys(user_id);
```

Migration number assigned at PR time (currently no other migration pending; this is the only new migration in this PR).

### 3.2 API endpoints

- `GET /api/me/provider-keys` → list with mask metadata (never value)
- `PUT /api/me/provider-keys/:keyName` → set/update
- `DELETE /api/me/provider-keys/:keyName` → clear

### 3.3 Wizard pre-fill

For each envKey the selected CEO adapter declares (`getAdapterDefaults(adapter).envKeys`), the wizard input pre-fills from:

1. `user_provider_keys.get(user.id, keyName)` — if present, masked display
2. `process.env[keyName]` — only during first-run onboarding (no companies exist yet)
3. empty otherwise

On submit, value is written to the company `secrets` table; if "Save to my profile" is checked (default), also written to `user_provider_keys`.

### 3.4 Agent editor

Each envKey row in the agent's adapter-config env editor gets a *"Use my saved key"* toggle when a matching `user_provider_keys` row exists. ON → row resolves to the user's key at agent-create-time, writing a company secret ref. OFF → operator enters explicit value.

## 4. Validation plan

Before merging this PR, perform an empirical spike to validate the assumptions:

### 4.1 Spike: helm install Daytona on kind (45 min)

Prerequisite: Docker for Mac with at least 8GB allocated, Kind 0.20+, Helm 3.12+.

```bash
# 1. Create kind cluster
cat <<EOF | kind create cluster --name paperclip --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    image: kindest/node:v1.27.3
    extraPortMappings:
      - containerPort: 30100
        hostPort: 3100
EOF

# 2. Install nginx-ingress (Daytona uses ingress with TLS)
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.10.0/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=180s

# 3. Install Daytona with minimal config
helm repo add daytonaio https://charts.daytona.io
helm install daytona daytonaio/daytona \
  --namespace daytona --create-namespace \
  --set baseDomain=daytona.127.0.0.1.nip.io \
  --set services.api.ingress.selfSigned=true \
  --set harbor.enabled=false \
  --set dex.enabled=false \
  --set pgadmin4.enabled=false \
  --wait --timeout 10m

# 4. Verify Daytona API responds
kubectl -n daytona port-forward svc/daytona-api 3000:3000 &
curl http://localhost:3000/health
```

**Pass criteria:** Daytona API responds 200 on /health.

### 4.2 Spike: existing Daytona plugin against bundled instance (30 min)

Validates the "no new paperclip code" assumption:

1. Mint an API key via the Daytona API.
2. Run paperclip-server on host with `PAPERCLIP_SANDBOX_PROVIDER=daytona`, `PAPERCLIP_DAYTONA_API_URL=http://localhost:3000`, `PAPERCLIP_DAYTONA_API_KEY=...`.
3. Through paperclip's onboarding, create a CEO bound to a sandbox-daytona environment.
4. Trigger a one-turn agent task.
5. Observe a sandbox pod appearing in the daytona namespace.
6. Confirm logs stream back into paperclip's run view.

**Pass criteria:** sandbox pod created in daytona namespace, agent task completes end-to-end, paperclip surfaces stdout/stderr.

**Failure modes worth documenting (not blockers):**
- SDK version skew (paperclip's `@daytonaio/sdk@0.171.0` vs OSS chart's Daytona-API version)
- TLS cert verification across the cluster service mesh
- Whether `Sandbox.create()` accepts the same params on OSS as Cloud

If 4.2 reveals plugin-code adjustments are needed, those become scope additions to this PR — but staying minimal (no architecture changes).

### 4.3 Decision after spike

- **Pass both spikes:** proceed with full Helm chart + onboarding wiring + user_provider_keys table.
- **Pass 4.1, fail 4.2:** report the gap; decide whether to fix the plugin (cheap), fork Daytona (expensive), or fall back to in-tree M4b after all.
- **Fail 4.1:** Daytona OSS doesn't actually work on kind cleanly. Re-evaluate — perhaps Daytona-via-EKS-cluster spike instead, or pivot to Coder.

## 5. M-stack closure plan

Once this PR is validated working end-to-end (Daytona + plugin + agent task completing on kind), close the M-stack PRs with a coordinating comment explaining the pivot:

- #5556 (M1 — multi-tenant kubernetes execution target)
- #5558 (M2 — headless agent execution end-to-end on Kubernetes)
- #5565 (M3a — real claude-code, real git creds, empirical sizing, Cilium DSL)
- #5576 (M3b — Redis rate limiter, image allow-list, multi-adapter coverage)

The work isn't deleted — it lives in the branches and the closed PRs. If Daytona ever fails as a vendor (license change, abandonment) the M-stack is a usable starting point for in-tree fallback. But it doesn't get merged.

#5736 (M4a — missing workspace deps bugfix) **stays open and ships.** Those bugs (missing `@types/node` in shared, missing `@paperclipai/execution-target-kubernetes` in cli/) are real bugs that exist regardless of execution backend. The cli/ fix is moot once M-stack is closed (the import goes away), but the `shared/@types/node` fix is independently valuable. Re-target M4a to master after rebase.

#5584 (OAuth backbone) and #5647 (OAuth UI) are **unrelated to the execution-runtime decision** and continue independently.

## 6. Configuration reference (user-facing)

Documented in `charts/paperclip/README.md`. Key values:

| Key | Default | Notes |
|---|---|---|
| `paperclip.image.tag` | `Chart.AppVersion` | override for staging tags |
| `paperclip.env.BETTER_AUTH_SECRET` | (required) | helm error if empty |
| `paperclip.env.PAPERCLIP_RUN_JWT_SECRET` | (required) | helm error if empty |
| `paperclip.sandbox.provider` | `daytona` | one of `daytona`, `local`, `e2b`, `<plugin-name>` |
| `paperclip.sandbox.daytona.apiUrl` | auto-derived | override to point at external Daytona |
| `paperclip.sandbox.daytona.apiKey` | auto-minted | override to use existing key |
| `daytona.enabled` | `true` | set `false` to use external Daytona only |
| `daytona.baseDomain` | `daytona.local` | set to a domain you control |
| `daytona.harbor.enabled` | `false` | enable if you need a private registry |
| `daytona.runners.runtimeClass` | unset | set to `kata-fc` for microVM isolation |
| `postgresql.enabled` | `true` | set `false` to use external Postgres |
| `postgresql.auth.password` | (required) | helm error if empty |

## 7. Out of scope (deferred)

| Item | Why deferred |
|---|---|
| Multi-cluster: dispatching across multiple Daytona instances | Single-instance is sufficient for V1. Daytona's own scaling handles intra-cluster runner growth. |
| Auto-rotation of bundled Daytona API key | Manual rotation via `helm upgrade --recreate-pods` suffices initially. |
| Cilium-based egress filtering | Daytona has its own network policy model; investigate before re-implementing. |
| Kata-FC support tested + documented | This PR documents the values flag; comprehensive testing happens on a real bare-metal cluster, separate exercise. |
| Snapshot / workspace persistence UI in Paperclip | Daytona supports this at the API level; surfacing it in Paperclip's UI is a follow-up feature. |
| SSH-to-sandbox button in run viewer | Daytona Proxy + SSH Gateway exposes this; integrate into Paperclip UI in a follow-up. |
| Metrics: pod startup latency, image pull duration | Wire to Daytona's Grafana stack in a follow-up. |
| Coder / Microsandbox alternative plugins | E2B plugin already exists; users wanting Coder can write a plugin. Microsandbox is experimental — revisit when stable. |
| Helm chart for Kata install prerequisite | Out of scope; documented as a separate prerequisite. |

## 8. Testing strategy

### 8.1 Unit tests

- `maybeRegisterBundledDaytonaEnvironment` — environment created only when env vars present; idempotent on re-boot; per-company creation.
- `userProviderKeysService` — CRUD + encryption round-trip.
- Wizard pre-fill precedence (user-keys > server-env > null) with `isFirstRunOnboarding` gate.
- Onboarding-state endpoint exposes sandbox-provider detection.

### 8.2 Integration tests

- New: `server/src/__tests__/daytona-bundled-onboarding.test.ts` — end-to-end onboarding flow with `PAPERCLIP_SANDBOX_PROVIDER=daytona` env. Mock the Daytona API. Confirm CEO is created with `default_environment_id` pointing at the bundled daytona environment.

### 8.3 Helm chart tests

- `helm template` produces valid YAML across `values.yaml` and `values.kata.yaml`.
- `helm test` against a kind cluster validates the three smoke tests (Section 1.6).
- The 4.1 + 4.2 spikes are codified as a manual playbook in `charts/paperclip/CONTRIBUTING.md`.

### 8.4 E2E tests

Existing Playwright suite gets one new scenario:

- **Bundled-Daytona onboarding** — boot paperclip-server with `PAPERCLIP_SANDBOX_PROVIDER=daytona` plus mocked Daytona API responses, run through onboarding, verify resulting CEO is bound to the Daytona environment and has `adapter_config.env.ANTHROPIC_API_KEY = { ref: "provider.anthropic-api-key" }`.

# K8s Execution Target Changelog

## M3b — 2026-05-09

Production hardening of the Kubernetes execution path:

- **Cross-replica Redis rate limiting.** New `createRedisSlidingWindowLimiter` backed by an atomic `EVAL` over Redis sorted sets. Factory in `server/src/routes/k8s-callback.ts` picks the Redis-backed limiter when `PAPERCLIP_REDIS_URL` is set, otherwise falls back to the in-memory limiter (single-replica only). Documented in `security-model.md`.
- **Per-cluster image allow-list.** New `image_allowlist text[]` column on `cluster_connections`. Driver enforces prefix-match on both the resolved adapter image and any `target.imageOverride` before launching the Job; rejects with `errorCode: "image_not_allowed"`. New CLI subcommand `paperclip cluster set-image-allowlist`.
- **Six new cloud-runtime adapter images:** `agent-runtime-codex`, `-gemini`, `-acpx`, `-opencode`, `-pi`, `-hermes`. Each has a Dockerfile, buildx-bake target, and busybox-style smoke test. Per-adapter env keys + default FQDN allow-list live in `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts` (single source of truth used by the driver). The driver now filters the per-Job env Secret to the adapter's declared `envKeys` and merges the adapter's `allowFqdns` into `ensureTenant`, removing the need for adapter-specific knowledge in server callers.
- **Always-hash namespace derivation.** `deriveNamespaceName` now unconditionally appends `-<8-char-base36-hash(companyId)>` to every namespace, even for short clean slugs. Previously two companies with identical slugs (e.g. both named "Acme") collided on the `cluster_namespace_bindings` unique index, which blocked Company B onboarding. Always-hash makes namespace names globally unique by construction; the M1 takeover guard remains as belt-and-suspenders.
- **Schema migration `0085`** adds the `image_allowlist` column.

`hermes_local` ships as a stub Dockerfile because no upstream npm binary is wired into Paperclip locally yet (see `Dockerfile.hermes` for the gap and path forward).

## M3a — 2026-05-09

Production-readiness pass on the M2 Kubernetes execution path:

- **Real claude-code end-to-end test** (`test/integration/claude-code-real.test.ts`). Gated on `K8S_INTEGRATION=1` + `ANTHROPIC_API_KEY`. Builds the real `agent-runtime-claude` image, seeds a workspace PVC with a fixture repo, runs the agent against real Anthropic, asserts the project name surfaces in pod logs.
- **Real `issueGitCredentials`** (`server/src/services/git-credentials.ts`). Replaces the M2 stub. Resolves a `company_secrets` UUID via the existing `SecretProvider` registry, returns `{username, password}` decoded from JSON. New CLI subcommand `paperclip cluster set-git-credentials`.
- **Empirical resource defaults** (`packages/adapters/kubernetes-execution/test/integration/empirical-measurement.test.ts`). 5 sequential real-claude-code runs measured under `metrics-server`. Defaults updated only when peaks crossed M1's threshold; new sizing doc at `docs/k8s-execution/sizing.md`.
- **Per-tenant Cilium DSL** (`packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.ts`). New columns on `cluster_tenant_policies`: `cilium_dns_allowlist` + `cilium_egress_cidrs`. `ensureTenantNamespace` emits a *second* CNP that intersects with the M1 baseline (Cilium evaluates multiple CNPs as AND). Operator recipes at `docs/k8s-execution/cilium-recipes.md`.

Schema migration `0084_tenant_policy_m3a.sql` adds 3 columns (`git_credentials_secret_id`, `cilium_dns_allowlist`, `cilium_egress_cidrs`) to `cluster_tenant_policies`.

## 2026-05-09 — Phase A complete

Workspace strategy + realization types now live in @paperclipai/workspace-strategy.
@paperclipai/shared re-exports them so existing callers were not modified.
Callers may opt to migrate imports in a follow-up; this PR keeps blast radius
to the smallest reasonable cross-section.

## 2026-05-09 — Phase C: server callback routes (M2 Tasks 13–16)

Three callback endpoints used by the in-cluster agent shim are now mounted in
the Paperclip server when `PAPERCLIP_RUN_JWT_SECRET` is configured:

- `POST /api/agent-auth/exchange` — bootstrap token → run JWT (HS256, 1h TTL).
- `POST /api/runs/:runId/events` — run JWT-authed structured event ingestion;
  events land in `heartbeat_run_events` keyed by `(runId, seq)`.
- `POST /api/workspace/git-credentials` — run JWT-authed short-TTL git creds.

Rate limits (in-memory sliding window per replica):
- `/agent-auth/exchange`: 10/min/IP (companyId is unknown until token validates).
- `/runs/:runId/events`: 1000/min keyed by URL `:runId`.
- `/workspace/git-credentials`: 30/min keyed by JWT runId claim, falling back
  to client IP if no valid JWT presented.

**Deferred to M3:**
- Live git-credentials issuance (GitHub App installation tokens, per-tenant
  deploy tokens). M2 ships the route and auth contract; the issuer currently
  always returns `503 not_configured`. Wiring is a single-function swap on the
  `issueGitCredentials` dependency.
- Distributed rate limiting. The in-memory limiter is per-replica; multi-replica
  deployments should lift this to Redis or a fronting proxy (Envoy/NGINX).
- `PAPERCLIP_RUN_JWT_SECRET` must be supplied as an external secret. The route
  factory fails fast at boot if it's unset, so deployments never silently
  generate per-restart keys (which would invalidate every in-flight JWT).

## 2026-05-09 — Risk #4 (empirical resource defaults) partially resolved

The empirical-measurement integration test
(`packages/adapters/kubernetes-execution/test/integration/empirical-measurement.test.ts`)
provisions kind + metrics-server and runs a Job under measurement. Peak CPU /
memory are captured via `kubectl top pod` polling and written to
`docs/k8s-execution/sizing-fake-agent.md`.

**M2 ships M1 defaults unchanged.** The measured workload (busybox echo loop)
is not representative of real claude_local — its peak memory is well under
100 Mi vs the M1 default of 256 Mi requests / 1 Gi limit. Real claude-code
measurement requires the M3 agent-runtime-claude image with valid Anthropic
protocol; it will be done in M3 and the defaults updated accordingly.

The infrastructure (metrics-server bootstrap, pod-metrics polling, sizing.md
generation) is in place. M3 only needs to swap the workload, not rebuild the
harness.

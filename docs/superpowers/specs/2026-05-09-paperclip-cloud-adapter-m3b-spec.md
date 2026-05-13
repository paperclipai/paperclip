# Paperclip Cloud Adapter — M3b Spec: Hardening + Multi-Adapter Coverage

**Status:** Approved 2026-05-09. Implementation plan to follow.

**Parent spec:** [2026-05-08-paperclip-cloud-adapter-design.md](./2026-05-08-paperclip-cloud-adapter-design.md)
**M3a addendum (currently in PR #5565):** [2026-05-09-paperclip-cloud-adapter-m3a-addendum.md](./2026-05-09-paperclip-cloud-adapter-m3a-addendum.md)

## Why this exists

M3a closed the four production-readiness gaps the M2 design left (real claude-code test, real `issueGitCredentials`, empirical sizing scaffolding, per-tenant Cilium DSL). Three classes of work remain before the cloud adapter is a complete production-grade feature:

1. **Multi-replica server scaling.** M2's in-memory rate limiter evades cross-replica enforcement. Multi-replica deployments hit different processes and bypass the bootstrap-token-exchange and runs-events throttling.

2. **Per-cluster image governance.** `cluster_connections.allowAgentImageOverride` is a coarse on/off boolean. Operators can't restrict image overrides to specific registries — they get all-or-nothing.

3. **Adapter breadth.** M2/M3a only run `claude_local`. The other adapters Paperclip supports locally (codex, gemini, opencode, acpx, pi, hermes) need cloud runtime images.

M3b ships all three in one tactical PR. **Operator UI and live run dashboard are deferred to M3c** — they add UX/frontend work that needs separate scoping.

---

## 1. Cross-replica Redis rate limit store

### Problem

`server/src/routes/k8s-callback.ts` defines `createSlidingWindowLimiter(opts)` returning a `SlidingWindowLimiter` with `consume(key)` and `stop()`. The implementation tracks hits in a `Map<string, number[]>` per process. Three limiters exist:

- `exchangeLimiter` — 10 req/min per client IP, gates `/agent-auth/exchange`
- `eventsLimiter` — 1000 req/min per `run:<runId>`, gates `/runs/:runId/events`
- `gitCredsLimiter` — 30 req/min per `run:<runId>` (or IP fallback), gates `/workspace/git-credentials`

In a multi-replica deployment (e.g. K8s Deployment with `replicas: 3`), an attacker — or even a normal client behind a load balancer — distributes their requests across processes and each process sees a fraction of the volume. Effective limit becomes `replicas × configured-limit`.

### Design

Add a Redis-backed implementation that satisfies the existing `SlidingWindowLimiter` interface. Selection happens once at server startup based on `PAPERCLIP_REDIS_URL`:

```ts
function createLimiter(opts: { name: string; windowMs: number; max: number }): SlidingWindowLimiter {
  const url = process.env.PAPERCLIP_REDIS_URL?.trim();
  if (url) return createRedisSlidingWindowLimiter({ url, ...opts });
  logger.warn("PAPERCLIP_REDIS_URL not set; using in-memory rate limiter (single-replica only)");
  return createSlidingWindowLimiter(opts);
}
```

The factory takes a `name` (e.g. `"exchange"`) so Redis keys are namespaced per limiter.

### Storage

One Redis sorted set per (limiter, key) pair:

- Key: `paperclip:rl:<limiter-name>:<consume-key>`
- Member: a unique nonce (timestamp + random suffix) to support concurrent ZADDs
- Score: timestamp in ms

`consume(key)` runs (in a single Lua script for atomicity):

```lua
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)
local count = redis.call('ZCARD', KEYS[1])
if count >= max then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return { 0, tonumber(oldest[2]) + windowMs - now }
end
redis.call('ZADD', KEYS[1], now, ARGV[4])  -- ARGV[4] = unique nonce
redis.call('PEXPIRE', KEYS[1], windowMs * 2)
return { 1, 0 }
```

Returns `{1, 0}` for allowed, `{0, retryAfterMs}` for rate-limited. The `PEXPIRE` bounds key lifetime so abandoned keys don't accumulate.

### Connection management

The Redis client is created once at server startup and shared across limiters. Connection failures during `consume()` fail open — log a warning and allow the request. Better to admit a request that should have been throttled than to 500 the entire endpoint when Redis blips.

### Configuration

- `PAPERCLIP_REDIS_URL` — required for production multi-replica deployments. Format `redis://[:password@]host:port[/db]` or `rediss://...` for TLS.
- Documented in `docs/k8s-execution/security-model.md` (new section "Production rate limiting").

### Files

- New: `server/src/routes/_limiter-redis.ts` (~120 lines including the Lua script as a string + the unit tests against an embedded Redis or `redis-mock`)
- Modify: `server/src/routes/k8s-callback.ts` — `createLimiter` factory, replace direct `createSlidingWindowLimiter` calls
- Modify: `server/package.json` — add `redis: ^4.7.0`
- Modify: `docs/k8s-execution/security-model.md` — append "Production rate limiting" section

### Tests

- Unit test the Redis impl against `ioredis-mock` or `redis-mock` covering: allow-under-limit, deny-at-limit, deny-with-correct-retry-after, eviction-after-window.
- Integration test against a real Redis container (only runs with `K8S_INTEGRATION=1` and a Redis URL).

### Output

- ~120 lines of new code + tests
- One new dep
- One docs section

**Estimated work: 2 days.**

---

## 2. Per-cluster image allow-list

### Problem

`cluster_connections.allowAgentImageOverride` is a coarse `boolean` (stored as `text` "true"/"false" per the existing schema). Today's behavior:

- `false` → driver ignores `target.imageOverride`
- `true` → driver accepts any `target.imageOverride`

Operators who want "allow overrides only to my private registry" or "only `paperclipai/*` and `internal-registry.acme.com/agents/*`" have no path. The boolean is too coarse for any real security posture.

### Design

Add a `text[]` column `image_allowlist` on `cluster_connections`. Semantics:

- **Empty array** (default) → preserves M2 behavior: respect `allowAgentImageOverride` boolean alone
- **Non-empty array** → both the default adapter image AND `target.imageOverride` (if any) must string-start-with one of the prefixes

The two-mode shape is a deliberate transition aid. M3b doesn't drop `allowAgentImageOverride`; M4 does, after operators have migrated.

### Enforcement

In `driver.run()`, **before** `createAgentJob(client, job)`:

```ts
const allowlist = connection.imageAllowlist ?? [];
if (allowlist.length > 0) {
  const baseImage = runContext.image;  // resolved adapter image
  const overrideImage = target.imageOverride;
  const baseAllowed = allowlist.some(p => baseImage.startsWith(p));
  if (!baseAllowed) {
    return { exitCode: null, errorCode: "image_not_allowed",
             errorMessage: `Adapter image ${baseImage} not in cluster allow-list` };
  }
  if (overrideImage !== undefined && !allowlist.some(p => overrideImage.startsWith(p))) {
    return { exitCode: null, errorCode: "image_not_allowed",
             errorMessage: `Override image ${overrideImage} not in cluster allow-list` };
  }
}
// fall through to existing allowAgentImageOverride boolean check
```

### Schema

Migration `0085_cluster_image_allowlist.sql`:

```sql
ALTER TABLE "cluster_connections"
  ADD COLUMN "image_allowlist" text[] NOT NULL DEFAULT ARRAY[]::text[];
```

Drizzle schema gets:

```ts
imageAllowlist: text("image_allowlist").array().notNull().default(sql`ARRAY[]::text[]`),
```

The `ResolvedClusterConnection` type in `packages/adapters/kubernetes-execution/src/types.ts` gains `imageAllowlist: string[]`. The `cluster-connections.ts` server service surfaces it on read and accepts it on `update()`.

### CLI

New subcommand:

```bash
paperclip cluster set-image-allowlist --cluster <id> --prefixes "ghcr.io/paperclipai/,internal.acme.com/agents/"
```

- `--prefixes ""` (empty) clears the list
- Comma-separated, trimmed, empty entries dropped (mirrors `set-cilium-policy` from M3a)

The CLI dispatcher gets one new case `set-image-allowlist`. The handler updates the `cluster_connections` row directly (this is per-cluster config, not per-tenant).

### Image-name semantics

Prefix matching is the only check. Tag pinning, signature verification, and vulnerability scanning are out of scope. The prefix check is sufficient to enforce "only my registry" — operators who want stronger guarantees use admission controllers (e.g. cosign-policy-controller) at the cluster level.

### Files

- Migration `packages/db/src/migrations/0085_cluster_image_allowlist.sql` + snapshot meta
- Drizzle schema update at `packages/db/src/schema/cluster_connections.ts`
- Server service update at `server/src/services/cluster-connections.ts`
- Type extension at `packages/adapters/kubernetes-execution/src/types.ts`
- Driver enforcement at `packages/adapters/kubernetes-execution/src/driver.ts` (~10 lines)
- New CLI subcommand at `cli/src/commands/cluster.ts`
- Tests for builder, enforcement, CLI

### Tests

- Unit: driver returns `image_not_allowed` for a non-matching override; allows the matching one; empty allow-list preserves M2 behavior.
- CLI: parses `--prefixes`, calls `update()` with the right shape; clears on empty string.

### Output

- 1 migration column + Drizzle schema snapshot
- ~30 lines of driver enforcement
- ~50 lines CLI subcommand + tests
- Type extension propagated through 3 files

**Estimated work: 3 days.**

---

## 3. Multi-adapter Kubernetes coverage — all 6

### Problem

M2 and M3a exercise only `claude_local` (the `agent-runtime-claude` image). Customers asking for codex, gemini, opencode, acpx, pi, or hermes on the cloud adapter currently can't use it.

### Pattern (per adapter)

Each adapter follows the M2 precedent set by `claude_local`:

1. **Runtime image** at `docker/agent-runtime/Dockerfile.<adapter>` extending `paperclipai/agent-runtime-base`. Installs the adapter's CLI globally (e.g. `npm i -g @anthropic-ai/claude-code` for `claude_local`; the equivalent for each other adapter).

2. **Per-adapter env mapping** in `driver.ts`: which keys from the per-Job env Secret get materialized for the agent-shim. Today the agent-shim reads `claude_local`'s `ANTHROPIC_API_KEY`. Each new adapter gets a small `Record<adapterType, string[]>` mapping.

3. **Per-adapter `adapterAllowFqdns` defaults** injected into `ensureTenantNamespace` so the M1 baseline NetworkPolicy + Cilium CNP allow the adapter to reach its API:

   - `codex` → `api.openai.com`
   - `gemini` → `generativelanguage.googleapis.com`
   - `opencode` → verify the actual host before commit
   - `acpx` → `api.anthropic.com` (acpx wraps Anthropic)
   - `pi` → verify against the local adapter's config
   - `hermes` → verify against the local adapter's config

   These defaults live as a TypeScript constant in `driver.ts`, easy to update.

4. **Smoke test** at `test/integration/<adapter>-smoke.test.ts` mirroring `claude-end-to-end.test.ts`'s busybox-fake pattern. Builds the per-adapter image, loads it into kind, runs a fake-Anthropic-style stub, asserts the pod boots and the agent-shim invokes the right CLI.

### Real-LLM tests

Out of scope for M3b. The `claude-code-real.test.ts` template (M3a Task 13) is the precedent; operators who want real-LLM tests for new adapters add their own equivalents. The cost-and-key-management story doesn't justify burning a CI budget on six real-LLM tests.

### Image tags

All 6 follow `paperclipai/agent-runtime-<adapter>:vX.Y.Z`, parallel to `agent-runtime-claude`. The `imagesByAdapter` map in `KubernetesDriverDeps` (M2) becomes the single configuration point.

### Sequencing within M3b

The first new adapter (recommend `codex` — most likely customer ask) shakes out the pattern. ~2 days. Once shaken out:

- `gemini`, `opencode`, `acpx`, `pi`, `hermes` each ~1 day = 5 days

Each adapter ships as a separate commit (or stack of commits) within the M3b branch. If adapter #6 hits friction, we land 5/6 in M3b and split the last to a follow-up PR — the milestone isn't blocked by one stuck adapter.

### Files per adapter

- `docker/agent-runtime/Dockerfile.<adapter>`
- Diff to `packages/adapters/kubernetes-execution/src/driver.ts` (env mapping + FQDN defaults entry)
- New `packages/adapters/kubernetes-execution/test/integration/<adapter>-smoke.test.ts`

### Cross-cutting

- New `docs/k8s-execution/adapters.md` table listing each adapter with its image tag, env keys, and FQDNs.

### Output

- 6 Dockerfiles
- 6 smoke tests
- ~12 lines per adapter in `driver.ts` (env + FQDN entries)
- 1 new docs page

**Estimated work: 12 days (2 + 5 × 1 = 7 best-case; 12 with friction buffer).**

---

## Out of scope for M3b → M3c

- Operator UI for cluster connections, namespace bindings, tenant policies
- Live run dashboard (log tail + event timeline)
- Helm chart packaging
- Image signing / cosign / sigstore verification
- GitHub App for git credentials (V2 / on-demand, regardless of milestone)
- New adapter additions beyond the existing six (e.g. third-party adapters customers ship themselves)

## Risks

| # | Risk | Mitigation |
|---|------|------------|
| A | Multi-adapter scope balloons; one or two adapters hit friction (FQDN unknown, CLI quirks) | Each adapter ships as a separate commit/PR within M3b. Land what works; split blockers to a follow-up. M3b PR isn't gated by adapter #6. |
| B | Redis adds operational dependency operators don't have | In-memory fallback + warn log preserves dev/single-replica UX. Documented in `security-model.md`. Helm chart in M3c (or M4) may bundle Redis. |
| C | Image allow-list schema migration on hot table | Additive column with default = no behavior change for existing rows. Reversible via `DROP COLUMN`. |
| D | Adapter FQDNs drift over time as upstream APIs add domains | Constants are easy to update; smoke tests don't hit real APIs so they don't break on drift. Operators can override per-tenant via the existing `additionalAllowFqdns` mechanism. |

## Estimated work

| Item | Days |
|------|------|
| 1. Redis rate limit | 2 |
| 2. Image allow-list | 3 |
| 3. 6 adapter runtimes | 12 |
| Cross-cutting (CHANGELOG, docs, integration plumbing) | 1 |
| **Total** | **18 = ~3.5 weeks** |

## Output summary

- **One PR**, ~30–40 commits, layered on master after M3a (#5565) merges
- **One schema migration** (`0085`), single column on `cluster_connections`
- **No new package** — all changes in existing packages
- **One new dep** (`redis`), one new docs page (`adapters.md`), one new docs section (Production rate limiting in `security-model.md`)

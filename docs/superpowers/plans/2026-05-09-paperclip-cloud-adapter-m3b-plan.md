# Paperclip Cloud Adapter — M3b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production-harden the M2 Kubernetes execution path: cross-replica Redis rate limiting, per-cluster image allow-list, and runtime-image coverage for the six remaining local adapters.

**Architecture:** Three independent items in one PR. Redis-backed limiter behind the existing `SlidingWindowLimiter` interface, factory-picked at startup. New `image_allowlist text[]` column on `cluster_connections` enforced in `driver.run()` before `createAgentJob`. Six new `agent-runtime-<adapter>` images extending the existing `agent-runtime-base`, with per-adapter env mapping + `adapterAllowFqdns` defaults centralised in `driver.ts`.

**Tech Stack:** TypeScript, Drizzle ORM, Postgres, Redis (`redis@^4.7.0`), vitest, Docker buildx, kind, Cilium (already wired in M3a).

**Spec reference:** `docs/superpowers/specs/2026-05-09-paperclip-cloud-adapter-m3b-spec.md`

**Branching:** Branch `feat/k8s-cloud-adapter-m3b`, layered on master after M3a (#5565) merges. Single PR.

---

## File Structure

### Create
- `server/src/routes/_limiter-redis.ts` — Redis sliding-window limiter implementation.
- `server/src/routes/_limiter-redis.test.ts` — unit tests against `ioredis-mock`.
- `packages/db/src/migrations/0085_cluster_image_allowlist.sql` — adds `image_allowlist text[]` column.
- `packages/db/src/migrations/meta/0085_snapshot.json` — Drizzle snapshot.
- `docker/agent-runtime/Dockerfile.codex` — codex_local runtime image.
- `docker/agent-runtime/Dockerfile.gemini` — gemini_local runtime image.
- `docker/agent-runtime/Dockerfile.acpx` — acpx_local runtime image.
- `docker/agent-runtime/Dockerfile.opencode` — opencode_local runtime image.
- `docker/agent-runtime/Dockerfile.pi` — pi_local runtime image.
- `docker/agent-runtime/Dockerfile.hermes` — hermes_local runtime image (stubbed; see Task 14).
- `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts` — central per-adapter env+FQDN config.
- `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts` — unit tests for defaults shape.
- `packages/adapters/kubernetes-execution/test/integration/codex-smoke.test.ts` — codex smoke test.
- `packages/adapters/kubernetes-execution/test/integration/gemini-smoke.test.ts` — gemini smoke test.
- `packages/adapters/kubernetes-execution/test/integration/acpx-smoke.test.ts` — acpx smoke test.
- `packages/adapters/kubernetes-execution/test/integration/opencode-smoke.test.ts` — opencode smoke test.
- `packages/adapters/kubernetes-execution/test/integration/pi-smoke.test.ts` — pi smoke test.
- `packages/adapters/kubernetes-execution/test/integration/hermes-smoke.test.ts` — hermes smoke test.
- `docs/k8s-execution/adapters.md` — adapter coverage table.

### Modify
- `server/src/routes/k8s-callback.ts` — factory function to pick limiter impl based on `PAPERCLIP_REDIS_URL`.
- `server/package.json` — add `redis: ^4.7.0` and `ioredis-mock` (devDep).
- `packages/db/src/schema/cluster_connections.ts` — add `imageAllowlist` column.
- `server/src/services/cluster-connections.ts` — surface `imageAllowlist` on read + accept on update.
- `packages/adapters/kubernetes-execution/src/types.ts` — add `imageAllowlist: string[]` to `ResolvedClusterConnection`.
- `packages/adapters/kubernetes-execution/src/driver.ts` — image allow-list enforcement + per-adapter defaults wiring.
- `cli/src/commands/cluster.ts` — new `set-image-allowlist` subcommand.
- `cli/src/commands/cluster.test.ts` — tests for new subcommand.
- `docker/agent-runtime/buildx-bake.hcl` — add 6 new bake targets.
- `docs/k8s-execution/security-model.md` — append "Production rate limiting" section.
- `docs/k8s-execution/CHANGELOG.md` — M3b entry.

---

## Phase A — Redis rate limiter (Tasks 1–3)

### Task 1: Redis sliding-window limiter implementation

**Files:**
- Create: `server/src/routes/_limiter-redis.ts`
- Create: `server/src/routes/_limiter-redis.test.ts`
- Modify: `server/package.json`

**Goal:** A new `createRedisSlidingWindowLimiter` that satisfies the existing `SlidingWindowLimiter` interface (`{consume(key), stop()}` with `{allowed, retryAfterSeconds}` return), backed by Redis sorted sets and an atomic Lua script.

- [ ] **Step 1: Add the Redis dependency**

```bash
pnpm --filter @paperclipai/server add redis@^4.7.0
pnpm --filter @paperclipai/server add -D ioredis-mock@^8.9.0
```

(`ioredis-mock` is fine even with `redis@4`; the Lua-supporting interface is mocked.)

- [ ] **Step 2: Write the failing test**

Create `server/src/routes/_limiter-redis.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RedisMock from "ioredis-mock";
import { createRedisSlidingWindowLimiter } from "./_limiter-redis.js";

// We use ioredis-mock + a thin shim so the redis@4 client interface our
// production code uses is satisfied at the test boundary.
function makeShimClient(): { client: any; mock: any } {
  const mock = new RedisMock();
  const client = {
    eval: async (script: string, opts: { keys: string[]; arguments: string[] }) => {
      // ioredis-mock supports `eval(script, numKeys, ...keys, ...args)`.
      // Translate the redis@4 shape (keys[]+arguments[]) to that.
      return mock.eval(script, opts.keys.length, ...opts.keys, ...opts.arguments);
    },
    quit: async () => mock.quit(),
  };
  return { client, mock };
}

describe("createRedisSlidingWindowLimiter", () => {
  let now = 1_700_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to max requests in the window, then denies", async () => {
    const { client } = makeShimClient();
    const limiter = createRedisSlidingWindowLimiter({
      client, name: "exchange", windowMs: 60_000, max: 3,
    });
    for (let i = 0; i < 3; i++) {
      const r = await limiter.consume("ip:1.2.3.4");
      expect(r.allowed).toBe(true);
    }
    const denied = await limiter.consume("ip:1.2.3.4");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    await limiter.stop();
  });

  it("forgets old hits past the window boundary", async () => {
    const { client } = makeShimClient();
    const limiter = createRedisSlidingWindowLimiter({
      client, name: "exchange", windowMs: 60_000, max: 1,
    });
    expect((await limiter.consume("ip:1.2.3.4")).allowed).toBe(true);
    expect((await limiter.consume("ip:1.2.3.4")).allowed).toBe(false);
    // Advance past the window.
    vi.setSystemTime(now + 61_000);
    expect((await limiter.consume("ip:1.2.3.4")).allowed).toBe(true);
    await limiter.stop();
  });

  it("isolates buckets per key", async () => {
    const { client } = makeShimClient();
    const limiter = createRedisSlidingWindowLimiter({
      client, name: "exchange", windowMs: 60_000, max: 1,
    });
    expect((await limiter.consume("ip:1.1.1.1")).allowed).toBe(true);
    expect((await limiter.consume("ip:2.2.2.2")).allowed).toBe(true);
    expect((await limiter.consume("ip:1.1.1.1")).allowed).toBe(false);
    await limiter.stop();
  });

  it("isolates buckets per limiter name", async () => {
    const { client } = makeShimClient();
    const a = createRedisSlidingWindowLimiter({ client, name: "exchange", windowMs: 60_000, max: 1 });
    const b = createRedisSlidingWindowLimiter({ client, name: "events",   windowMs: 60_000, max: 1 });
    expect((await a.consume("k")).allowed).toBe(true);
    expect((await b.consume("k")).allowed).toBe(true);
    expect((await a.consume("k")).allowed).toBe(false);
    expect((await b.consume("k")).allowed).toBe(false);
    await a.stop(); await b.stop();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/server exec vitest run src/routes/_limiter-redis.test.ts`
Expected: FAIL — `Cannot find module './_limiter-redis.js'`.

- [ ] **Step 4: Implement the limiter**

Create `server/src/routes/_limiter-redis.ts`:

```ts
import { randomBytes } from "node:crypto";
import type { SlidingWindowLimiter } from "./_limiter-types.js";

/**
 * Atomic sliding-window rate-limit step:
 *   1. Drop members older than (now - windowMs).
 *   2. If remaining count >= max, return {allowed=0, retryAfterMs}.
 *   3. Else add a unique member at score=now, refresh PEXPIRE, return allowed=1.
 *
 * KEYS[1] = redis sorted set
 * ARGV    = nowMs, windowMs, max, uniqueNonce
 * Result  = [ allowed (0|1), retryAfterMs ]
 */
const LUA_CONSUME = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local nonce = ARGV[4]
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)
local count = redis.call('ZCARD', KEYS[1])
if count >= max then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retry = tonumber(oldest[2]) + windowMs - now
  if retry < 1 then retry = 1 end
  return { 0, retry }
end
redis.call('ZADD', KEYS[1], now, nonce)
redis.call('PEXPIRE', KEYS[1], windowMs * 2)
return { 1, 0 }
`;

export interface RedisLikeClient {
  eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown>;
  quit?: () => Promise<unknown>;
}

export interface CreateRedisSlidingWindowLimiterOpts {
  client: RedisLikeClient;
  /** Namespace component baked into the Redis key (e.g. "exchange", "events"). */
  name: string;
  windowMs: number;
  max: number;
}

export function createRedisSlidingWindowLimiter(
  opts: CreateRedisSlidingWindowLimiterOpts,
): SlidingWindowLimiter {
  return {
    async consume(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
      const now = Date.now();
      const nonce = `${now}:${randomBytes(6).toString("hex")}`;
      try {
        const raw = (await opts.client.eval(LUA_CONSUME, {
          keys: [`paperclip:rl:${opts.name}:${key}`],
          arguments: [String(now), String(opts.windowMs), String(opts.max), nonce],
        })) as [number, number] | string[];
        // ioredis-mock returns string[]; redis@4 returns number[]. Coerce.
        const allowed = Number(Array.isArray(raw) ? raw[0] : 0) === 1;
        const retryMs = Number(Array.isArray(raw) ? raw[1] : 0);
        return { allowed, retryAfterSeconds: Math.max(0, Math.ceil(retryMs / 1000)) };
      } catch {
        // Fail open on Redis blips: better to admit a request that should
        // have been throttled than 500 the entire endpoint when Redis is
        // unreachable. The endpoint logs the upstream error separately.
        return { allowed: true, retryAfterSeconds: 0 };
      }
    },
    async stop() {
      // We don't own the client — caller is responsible for the Redis
      // connection lifecycle. stop() exists to satisfy the interface.
    },
  };
}
```

Also create `server/src/routes/_limiter-types.ts` to give both impls a shared interface file:

```ts
export interface SlidingWindowLimiter {
  consume(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> | { allowed: boolean; retryAfterSeconds: number };
  /** Stop any background timers / cleanup. */
  stop(): Promise<void> | void;
}
```

(The existing `SlidingWindowLimiter` interface in `k8s-callback.ts` becomes `import { type SlidingWindowLimiter } from "./_limiter-types.js"` in Task 2.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @paperclipai/server exec vitest run src/routes/_limiter-redis.test.ts`
Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/_limiter-redis.ts \
        server/src/routes/_limiter-redis.test.ts \
        server/src/routes/_limiter-types.ts \
        server/package.json server/pnpm-lock.yaml
# pnpm-lock may live at the root; if not modified at server/, git add the root one if changed.
git commit -m "feat(server): Redis sliding-window rate limiter via atomic Lua script"
```

---

### Task 2: Factory in k8s-callback to pick limiter impl

**Files:**
- Modify: `server/src/routes/k8s-callback.ts`

- [ ] **Step 1: Replace the inline limiter interface + impl import**

Open `server/src/routes/k8s-callback.ts`. Find the existing `export interface SlidingWindowLimiter` block + the `createSlidingWindowLimiter` function. Replace the interface line with an import:

```ts
import type { SlidingWindowLimiter } from "./_limiter-types.js";
import { createRedisSlidingWindowLimiter } from "./_limiter-redis.js";
import { createClient as createRedisClient } from "redis";
```

Keep the existing in-memory `createSlidingWindowLimiter` function as-is. Only its `: SlidingWindowLimiter` return type needs to be re-anchored to the imported interface (which is structurally compatible — same `consume` + `stop` shape, but `consume` returns either sync or async, and `stop` returns either sync or async; the in-memory impl returns sync, the Redis impl returns Promise — both satisfy the union).

Verify the in-memory impl's signatures still match the new shared interface. If TypeScript complains, narrow the in-memory `consume` return type to `{ allowed: boolean; retryAfterSeconds: number }` (sync) — TS unions accept that against `T | Promise<T>`.

- [ ] **Step 2: Add the factory + Redis client lifecycle**

Find the block inside `k8sCallbackRoutes` that creates the three limiters:

```ts
  const exchangeLimiter = createSlidingWindowLimiter({ windowMs: 60_000, max: 10 });
  const eventsLimiter = createSlidingWindowLimiter({ windowMs: 60_000, max: 1000 });
  const gitCredsLimiter = createSlidingWindowLimiter({ windowMs: 60_000, max: 30 });
```

Replace with:

```ts
  // Factory picks Redis-backed limiter when PAPERCLIP_REDIS_URL is set;
  // otherwise falls back to in-memory (suitable for dev / single-replica).
  // Production multi-replica deployments MUST configure Redis or the limits
  // are per-process and each replica grants the full quota independently.
  const redisUrl = process.env.PAPERCLIP_REDIS_URL?.trim();
  let redisClient: Awaited<ReturnType<typeof createRedisClient>> | null = null;
  if (redisUrl) {
    redisClient = createRedisClient({ url: redisUrl });
    redisClient.on("error", (err) => logger.error({ err }, "redis client error"));
    await redisClient.connect();
  } else {
    logger.warn("PAPERCLIP_REDIS_URL not set; rate limits enforced per-process only");
  }

  const makeLimiter = (name: string, opts: { windowMs: number; max: number }): SlidingWindowLimiter => {
    if (redisClient) {
      return createRedisSlidingWindowLimiter({
        client: {
          eval: (script, evalOpts) => redisClient!.eval(script, evalOpts) as Promise<unknown>,
          quit: () => redisClient!.quit() as Promise<unknown>,
        },
        name, windowMs: opts.windowMs, max: opts.max,
      });
    }
    return createSlidingWindowLimiter(opts);
  };

  const exchangeLimiter = makeLimiter("exchange", { windowMs: 60_000, max: 10 });
  const eventsLimiter = makeLimiter("events", { windowMs: 60_000, max: 1000 });
  const gitCredsLimiter = makeLimiter("gitcreds", { windowMs: 60_000, max: 30 });
```

The function `k8sCallbackRoutes(db, options)` is currently sync. Make it async:

Find `export function k8sCallbackRoutes(db: Db, options: K8sCallbackRoutesOptions = {}) {` and change to `export async function k8sCallbackRoutes(...)`.

- [ ] **Step 3: Update consume() callers to await**

Three places call `<limiter>.consume(key)` and read `limit.allowed`. The in-memory impl returns sync; the Redis impl returns Promise. Add `await` to each call:

Find lines like `const limit = exchangeLimiter.consume(clientIp(req));` and replace with:

```ts
    const limit = await exchangeLimiter.consume(clientIp(req));
```

Apply to all three handlers (`/agent-auth/exchange`, `/runs/:runId/events`, `/workspace/git-credentials`).

- [ ] **Step 4: Update callers of `k8sCallbackRoutes`**

Run: `grep -rn "k8sCallbackRoutes(" server/src/`

For each call site, prefix with `await`:

```ts
- app.use("/api", k8sCallbackRoutes(db, ...));
+ app.use("/api", await k8sCallbackRoutes(db, ...));
```

If a caller is itself sync, make it async up to the first natural await boundary.

- [ ] **Step 5: Run server typecheck and tests**

```bash
pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/server exec vitest run src/routes/
```

Expected: PASS. The existing rate-limit-related tests in `workspace-git-credentials.test.ts` and other route tests should keep passing because they inject their own dependencies; they don't touch the limiter.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/k8s-callback.ts $(git diff --name-only)
git commit -m "feat(server): factory-pick limiter impl based on PAPERCLIP_REDIS_URL"
```

---

### Task 3: Document production rate limiting

**Files:**
- Modify: `docs/k8s-execution/security-model.md`

- [ ] **Step 1: Append the section**

At the end of `docs/k8s-execution/security-model.md`, append:

```markdown
## Production rate limiting

The `/api/agent-auth/exchange`, `/api/runs/:runId/events`, and
`/api/workspace/git-credentials` endpoints carry sliding-window rate limits.
The limit budgets are:

| Endpoint                            | Window | Max  | Keyed by              |
|-------------------------------------|--------|------|-----------------------|
| `/api/agent-auth/exchange`          | 60s    | 10   | client IP             |
| `/api/runs/:runId/events`           | 60s    | 1000 | run id (`run:<id>`)   |
| `/api/workspace/git-credentials`    | 60s    | 30   | run id, IP fallback   |

### Backing store

By default the limits use a per-process in-memory sliding-window. **In a
multi-replica deployment this is insufficient**: a client distributing
requests across replicas evades the limit because each process sees a
fraction of the volume.

For production, set `PAPERCLIP_REDIS_URL` to a Redis 6+ instance reachable
from every replica. Format: `redis://[:password@]host:port[/db]` or
`rediss://...` for TLS.

When `PAPERCLIP_REDIS_URL` is set, the server uses an atomic Lua-script
based limiter against Redis sorted sets. Keys are namespaced
`paperclip:rl:<limiter>:<consume-key>` and expire `windowMs * 2` after the
last hit, so abandoned keys do not accumulate.

### Failure mode

Redis errors during `consume()` fail open: the request is admitted, the
error is logged. This protects availability when Redis blips at the cost of
admitting a request that should have been throttled.
```

- [ ] **Step 2: Commit**

```bash
git add docs/k8s-execution/security-model.md
git commit -m "docs(k8s-execution): document PAPERCLIP_REDIS_URL for production rate limiting"
```

---

## Phase B — Per-cluster image allow-list (Tasks 4–7)

### Task 4: Migration 0085 + Drizzle schema

**Files:**
- Create: `packages/db/src/migrations/0085_cluster_image_allowlist.sql`
- Create: `packages/db/src/migrations/meta/0085_snapshot.json` (regenerated)
- Modify: `packages/db/src/schema/cluster_connections.ts`

- [ ] **Step 1: Update the schema**

Open `packages/db/src/schema/cluster_connections.ts`. Add the import (if not present) and the column:

```ts
import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
```

Inside the `pgTable("cluster_connections", { … })` columns block, add (alphabetically alongside the other `text` columns or near `allowAgentImageOverride`):

```ts
    /** Per-cluster image allow-list: image must string-start-with one of these prefixes. */
    imageAllowlist: text("image_allowlist").array().notNull().default(sql`ARRAY[]::text[]`),
```

- [ ] **Step 2: Hand-write the SQL migration**

Create `packages/db/src/migrations/0085_cluster_image_allowlist.sql`:

```sql
ALTER TABLE "cluster_connections" ADD COLUMN "image_allowlist" text[] DEFAULT ARRAY[]::text[] NOT NULL;
```

- [ ] **Step 3: Run db build + numbering check**

Run: `pnpm --filter @paperclipai/db build`
Expected: PASS (numbering check + tsc + copy of `src/migrations` to `dist/migrations`).

- [ ] **Step 4: Run server typecheck**

Run: `pnpm --filter @paperclipai/server typecheck`
Expected: PASS.

- [ ] **Step 5: Generate the Drizzle snapshot**

Run: `pnpm --filter @paperclipai/db generate`
Expected: drizzle-kit emits `packages/db/src/migrations/meta/0085_snapshot.json` and updates `_journal.json`. If drizzle-kit is unable to generate (the same `dist/schema/*.test.js` issue that hit M3a Task 1 may recur), hand-craft the snapshot from `0084_snapshot.json` by adding the `image_allowlist` column to the `cluster_connections` table block. Confirm the resulting `_journal.json` lists `0085` with `tag: "0085_cluster_image_allowlist"`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/cluster_connections.ts \
        packages/db/src/migrations/0085_cluster_image_allowlist.sql \
        packages/db/src/migrations/meta/0085_snapshot.json \
        packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): cluster image allow-list column"
```

---

### Task 5: Server service surface for `imageAllowlist`

**Files:**
- Modify: `packages/adapters/kubernetes-execution/src/types.ts`
- Modify: `server/src/services/cluster-connections.ts`

- [ ] **Step 1: Extend the type**

Open `packages/adapters/kubernetes-execution/src/types.ts`. Find the `ResolvedClusterConnection` interface and add:

```ts
  /** Per-cluster image allow-list: image must string-start-with one of these prefixes. Empty = preserve M2 behavior. */
  imageAllowlist: string[];
```

(Place near `allowAgentImageOverride: boolean`.)

- [ ] **Step 2: Surface on the server service**

Open `server/src/services/cluster-connections.ts`. The interfaces likely have a `ClusterConnectionRow` and an `UpdateInput`. Find them.

For `ClusterConnectionRow` (or the equivalent type used by `mapRow` / `list` / `get`), add:

```ts
  imageAllowlist: string[];
```

For `mapRow` (which converts the Drizzle row to the service's row shape), add:

```ts
    imageAllowlist: row.imageAllowlist ?? [],
```

For the update interface, add an optional field:

```ts
  imageAllowlist?: string[];
```

And in the `update()` implementation's `set({...})`, conditionally include the column:

```ts
        ...(input.imageAllowlist !== undefined ? { imageAllowlist: input.imageAllowlist } : {}),
```

Also update the `resolve()` method (which builds a `ResolvedClusterConnection`) to include:

```ts
        imageAllowlist: row.imageAllowlist,
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter @paperclipai/server typecheck`
Expected: PASS. Any cluster-connection consumer that destructures the row will keep working — the new field is additive.

Run: `pnpm --filter @paperclipai/execution-target-kubernetes build`
Expected: PASS.

- [ ] **Step 4: Run existing service tests**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/cluster-connections.test.ts`
Expected: PASS. Existing tests don't assert on `imageAllowlist` so they pass through.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/types.ts \
        server/src/services/cluster-connections.ts
git commit -m "feat(server): surface imageAllowlist on cluster-connections service"
```

---

### Task 6: Driver enforcement of the allow-list

**Files:**
- Modify: `packages/adapters/kubernetes-execution/src/driver.ts`

- [ ] **Step 1: Write the failing unit test**

Append to `packages/adapters/kubernetes-execution/test/unit/driver-run.test.ts` (the existing M2 driver test file):

```ts
  it("rejects a run when default adapter image is not in cluster allow-list", async () => {
    const driver = makeFakeDriver({
      // Connection forces a tight allow-list that the resolved image violates.
      connectionImageAllowlist: ["internal.acme.com/agents/"],
      resolvedImage: "ghcr.io/paperclipai/agent-runtime-claude:v1",
    });
    const result = await driver.run({ ctx: makeCtx(), target: { clusterConnectionId: "c-1" } });
    expect(result.errorCode).toBe("image_not_allowed");
    expect(result.errorMessage).toMatch(/ghcr.io\/paperclipai\/agent-runtime-claude/);
  });

  it("rejects a run when the override image is not in the allow-list", async () => {
    const driver = makeFakeDriver({
      connectionImageAllowlist: ["ghcr.io/paperclipai/"],
      resolvedImage: "ghcr.io/paperclipai/agent-runtime-claude:v1",
    });
    const result = await driver.run({
      ctx: makeCtx(),
      target: { clusterConnectionId: "c-1", imageOverride: "evil.example.com/x:latest" },
    });
    expect(result.errorCode).toBe("image_not_allowed");
    expect(result.errorMessage).toMatch(/evil\.example\.com/);
  });

  it("permits a run whose images all match the allow-list", async () => {
    const driver = makeFakeDriver({
      connectionImageAllowlist: ["ghcr.io/paperclipai/"],
      resolvedImage: "ghcr.io/paperclipai/agent-runtime-claude:v1",
    });
    const result = await driver.run({
      ctx: makeCtx(),
      target: { clusterConnectionId: "c-1", imageOverride: "ghcr.io/paperclipai/custom:v2" },
    });
    // Either succeeded, cancelled, or any non-image-not-allowed terminal state.
    expect(result.errorCode).not.toBe("image_not_allowed");
  });

  it("falls through to existing allowAgentImageOverride when allowlist is empty", async () => {
    const driver = makeFakeDriver({
      connectionImageAllowlist: [],
      connectionAllowOverride: false,
      resolvedImage: "ghcr.io/paperclipai/agent-runtime-claude:v1",
    });
    const result = await driver.run({
      ctx: makeCtx(),
      target: { clusterConnectionId: "c-1", imageOverride: "ghcr.io/paperclipai/other:v1" },
    });
    // Empty allowlist + allowAgentImageOverride=false → existing M2 behavior:
    // override is ignored / rejected. We accept either a non-image error or a
    // successful run that used the default image.
    expect(result.errorCode).not.toBe("image_not_allowed");
  });
```

The helpers `makeFakeDriver` and `makeCtx` already exist in this file. If they don't accept `connectionImageAllowlist` and `connectionAllowOverride` yet, extend their types to take these (default `[]` and `true` respectively). Read the file first to follow its existing helper shape.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run test/unit/driver-run.test.ts`
Expected: 4 new FAILs.

- [ ] **Step 3: Implement enforcement in driver.ts**

Open `packages/adapters/kubernetes-execution/src/driver.ts`. Find the line near 379:

```ts
          image: target.imageOverride ?? runContext.image,
```

Immediately BEFORE the existing job-creation flow (find the block that creates the agent job — it's roughly between the call to `resolveRunContext` and `createAgentJob`), add the enforcement check:

```ts
        // Image allow-list enforcement (M3b). Empty list preserves M2 behavior:
        // the existing `allowAgentImageOverride` boolean (handled below) governs.
        // Non-empty list requires both default + override to string-start-with
        // one of the prefixes.
        const allowlist = connection.imageAllowlist ?? [];
        if (allowlist.length > 0) {
          const matchesAllowlist = (img: string): boolean =>
            allowlist.some((prefix) => img.startsWith(prefix));
          if (!matchesAllowlist(runContext.image)) {
            cancellation.dispose();
            return {
              exitCode: null, signal: null, timedOut: false,
              errorCode: "image_not_allowed",
              errorMessage: `Adapter image "${runContext.image}" not in cluster image_allowlist`,
            };
          }
          if (target.imageOverride !== undefined && !matchesAllowlist(target.imageOverride)) {
            cancellation.dispose();
            return {
              exitCode: null, signal: null, timedOut: false,
              errorCode: "image_not_allowed",
              errorMessage: `Override image "${target.imageOverride}" not in cluster image_allowlist`,
            };
          }
        }
```

The `errorCode: "image_not_allowed"` may need to be added to the `AdapterExecutionResult` errorCode union in `packages/adapter-utils/src/types.ts` (search there for the existing union). If the type rejects the new literal, extend it.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run test/unit/driver-run.test.ts`
Expected: PASS, including the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/driver.ts \
        packages/adapters/kubernetes-execution/test/unit/driver-run.test.ts \
        packages/adapter-utils/src/types.ts
git commit -m "feat(k8s-execution): enforce per-cluster image allow-list in driver.run()"
```

---

### Task 7: CLI subcommand `cluster set-image-allowlist`

**Files:**
- Modify: `cli/src/commands/cluster.ts`
- Modify: `cli/src/commands/cluster.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/commands/cluster.test.ts`:

```ts
  it("set-image-allowlist: passes --prefixes through as a string array", async () => {
    const m = mocks();
    (m.clusterConnections.update as any) = vi.fn(async () => MOCK_ROW);
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "set-image-allowlist",
      "--cluster", "c-1",
      "--prefixes", "ghcr.io/paperclipai/,internal.acme.com/agents/",
    ]);
    expect(code).toBe(0);
    const arg = (m.clusterConnections.update as any).mock.calls[0];
    expect(arg[0]).toBe("c-1");
    expect(arg[1].imageAllowlist).toEqual([
      "ghcr.io/paperclipai/",
      "internal.acme.com/agents/",
    ]);
  });

  it("set-image-allowlist: empty --prefixes clears the list", async () => {
    const m = mocks();
    (m.clusterConnections.update as any) = vi.fn(async () => MOCK_ROW);
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "set-image-allowlist",
      "--cluster", "c-1",
      "--prefixes", "",
    ]);
    expect(code).toBe(0);
    const arg = (m.clusterConnections.update as any).mock.calls[0];
    expect(arg[1].imageAllowlist).toEqual([]);
  });

  it("set-image-allowlist: errors when --cluster missing", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run(["set-image-allowlist", "--prefixes", "x/"]);
    expect(code).not.toBe(0);
  });
```

The mocks() helper's `ClusterConnectionsService` will need an `update` method on its interface. Check the M3a state of `cli/src/commands/cluster.ts` — if `ClusterConnectionsService.update` isn't there yet, add it:

```ts
export interface ClusterConnectionsService {
  // ... existing
  update(id: string, input: { imageAllowlist?: string[] }): Promise<ClusterConnectionRow>;
}
```

And in mocks() add `update: vi.fn(async () => MOCK_ROW) as any,`.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter paperclipai exec vitest run src/commands/cluster.test.ts`
Expected: 3 new FAILs.

- [ ] **Step 3: Add the dispatcher case + handler**

In `cli/src/commands/cluster.ts`, add to the dispatch switch (alongside `set-git-credentials` and `set-cilium-policy`):

```ts
      case "set-image-allowlist":
        return cmdSetImageAllowlist(rest, deps);
```

Then add the handler:

```ts
async function cmdSetImageAllowlist(argv: string[], deps: ClusterCommandDeps): Promise<number> {
  const { flags } = parseFlags(argv);
  const clusterId = flags["cluster"];
  if (!clusterId) {
    deps.print(
      "Usage: cluster set-image-allowlist --cluster <id> [--prefixes \"a/,b/\"]\n" +
        "  --prefixes \"\" clears the allow-list (default behavior).",
    );
    return 2;
  }
  const raw = flags["prefixes"] ?? "";
  // Comma-list parsing: split, trim, drop empty entries.
  const imageAllowlist = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  await deps.clusterConnections.update(clusterId, { imageAllowlist });
  if (imageAllowlist.length === 0) {
    deps.print(`Cleared image_allowlist for cluster ${clusterId}`);
  } else {
    deps.print(`Updated image_allowlist for cluster ${clusterId}: ${imageAllowlist.join(", ")}`);
  }
  return 0;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter paperclipai exec vitest run src/commands/cluster.test.ts`
Expected: PASS, including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/cluster.ts cli/src/commands/cluster.test.ts
git commit -m "feat(cli): cluster set-image-allowlist subcommand"
```

---

## Phase C — Multi-adapter coverage (Tasks 8–14)

### Task 8: Adapter defaults registry

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts`
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts`
- Modify: `packages/adapters/kubernetes-execution/src/index.ts` (re-export)

**Goal:** A single source of truth for per-adapter defaults: which env keys to materialize from the per-Job Secret, and which FQDNs to allow egress to. Each Phase C task adds ONE adapter's row to this registry.

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  ADAPTER_DEFAULTS,
  getAdapterDefaults,
  type AdapterDefaults,
} from "./adapter-defaults.js";

describe("adapter defaults registry", () => {
  it("claude_local has known shape", () => {
    const d = getAdapterDefaults("claude_local");
    expect(d.runtimeImage).toMatch(/agent-runtime-claude/);
    expect(d.envKeys).toContain("ANTHROPIC_API_KEY");
    expect(d.allowFqdns).toContain("api.anthropic.com");
  });

  it("returns defaults for an unknown adapter", () => {
    const d = getAdapterDefaults("totally-made-up");
    // Unknown adapter falls back to base image + zero env keys + zero FQDNs.
    // The driver still functions (will fail to invoke the unknown CLI inside
    // the container) but provisioning succeeds.
    expect(d.runtimeImage).toMatch(/agent-runtime-base/);
    expect(d.envKeys).toEqual([]);
    expect(d.allowFqdns).toEqual([]);
  });

  it("every registered adapter has a non-empty runtimeImage", () => {
    for (const [type, defaults] of Object.entries(ADAPTER_DEFAULTS)) {
      expect(defaults.runtimeImage, `adapter=${type}`).toBeTruthy();
    }
  });

  it("type guard: AdapterDefaults requires the three fields", () => {
    const sample: AdapterDefaults = { runtimeImage: "x", envKeys: [], allowFqdns: [] };
    expect(sample.runtimeImage).toBe("x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run src/orchestrator/adapter-defaults.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

Create `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts`:

```ts
/**
 * Per-adapter cloud-runtime defaults.
 *
 * Each entry tells the driver:
 *   - runtimeImage:  Which `agent-runtime-<adapter>` image to run (default
 *                    fallback is `agent-runtime-base`, which has no adapter
 *                    CLI and only succeeds for adapters whose binary is
 *                    already on PATH via the base image).
 *   - envKeys:       Which keys the driver should materialize from the
 *                    per-Job env Secret into the container's environment.
 *                    The Secret itself is populated by the server (from
 *                    company secrets) before driver.run() is called.
 *   - allowFqdns:    DNS names the tenant's NetworkPolicy + optional Cilium
 *                    CNP must permit egress to. Per-tenant policy overrides
 *                    via cluster_tenant_policies.networkJson.additionalAllowFqdns
 *                    are merged on top in ensureTenantNamespace.
 *
 * The image tags use `:vDEFAULT` as a sentinel; the actual tag is injected
 * by the server's `resolveRunContext` (which knows the deployed Paperclip
 * version). M3b only ships the per-adapter image NAME; tag handling is
 * unchanged from M2.
 */

export interface AdapterDefaults {
  /** Image name without tag, e.g. "ghcr.io/paperclipai/agent-runtime-claude". */
  runtimeImage: string;
  /** Env keys to copy from the per-Job Secret into the container environment. */
  envKeys: string[];
  /** FQDNs the tenant must be permitted egress to for the adapter to function. */
  allowFqdns: string[];
}

const REGISTRY_BASE = "ghcr.io/paperclipai";

export const ADAPTER_DEFAULTS: Record<string, AdapterDefaults> = {
  claude_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-claude`,
    envKeys: ["ANTHROPIC_API_KEY"],
    allowFqdns: ["api.anthropic.com"],
  },
};

export function getAdapterDefaults(adapterType: string): AdapterDefaults {
  return (
    ADAPTER_DEFAULTS[adapterType] ?? {
      runtimeImage: `${REGISTRY_BASE}/agent-runtime-base`,
      envKeys: [],
      allowFqdns: [],
    }
  );
}
```

- [ ] **Step 4: Re-export from package index**

Open `packages/adapters/kubernetes-execution/src/index.ts`. Add:

```ts
export {
  ADAPTER_DEFAULTS,
  getAdapterDefaults,
  type AdapterDefaults,
} from "./orchestrator/adapter-defaults.js";
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run src/orchestrator/adapter-defaults.test.ts`
Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts \
        packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts \
        packages/adapters/kubernetes-execution/src/index.ts
git commit -m "feat(k8s-execution): adapter-defaults registry (claude_local seed)"
```

---

### Task 9: codex_local — Dockerfile + defaults entry + smoke test

**Files:**
- Create: `docker/agent-runtime/Dockerfile.codex`
- Modify: `docker/agent-runtime/buildx-bake.hcl`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts`
- Create: `packages/adapters/kubernetes-execution/test/integration/codex-smoke.test.ts`

- [ ] **Step 1: Add the Dockerfile**

Create `docker/agent-runtime/Dockerfile.codex`:

```dockerfile
# syntax=docker/dockerfile:1.6
ARG BASE_TAG=dev
FROM paperclipai/agent-runtime-base:${BASE_TAG}

USER root
RUN npm install -g @openai/codex@latest \
    && chown -R 1000:1000 /usr/lib/node_modules \
    || true

# @openai/codex installs as 'codex'; the agent-shim invokes it directly.
RUN command -v codex >/dev/null 2>&1 || (echo "codex not on PATH"; exit 1)

USER 1000:1000

# Verify the CLI is on PATH for the shim's exec.LookPath
RUN command -v codex >/dev/null 2>&1 || (echo "codex not on PATH"; exit 1)
```

- [ ] **Step 2: Add the bake target**

Open `docker/agent-runtime/buildx-bake.hcl`. Find the `group "default"` line and extend its target list:

```hcl
group "default" {
  targets = ["base", "claude", "codex"]
}
```

Append a new target block:

```hcl
target "codex" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.codex"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-codex:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}
```

- [ ] **Step 3: Update the failing test**

Append to `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts`:

```ts
  it("codex_local has expected env + fqdn defaults", () => {
    const d = getAdapterDefaults("codex_local");
    expect(d.runtimeImage).toMatch(/agent-runtime-codex/);
    expect(d.envKeys).toContain("OPENAI_API_KEY");
    expect(d.allowFqdns).toContain("api.openai.com");
  });
```

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run src/orchestrator/adapter-defaults.test.ts`
Expected: 1 new FAIL.

- [ ] **Step 4: Add the registry entry**

In `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts`, add to `ADAPTER_DEFAULTS`:

```ts
  codex_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-codex`,
    envKeys: ["OPENAI_API_KEY"],
    allowFqdns: ["api.openai.com"],
  },
```

Re-run the test — expect PASS.

- [ ] **Step 5: Write the smoke test**

Create `packages/adapters/kubernetes-execution/test/integration/codex-smoke.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spinUpKind, type KindCluster } from "./_harness.js";
import { buildBusyboxTestJob } from "./_helpers/busybox-job.js";
import { createKubernetesApiClient } from "../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe.skipIf(!process.env["K8S_INTEGRATION"])(
  "codex_local runtime image smoke",
  () => {
    let kind: KindCluster;
    const IMAGE = "paperclipai/agent-runtime-codex:test-m3b";

    beforeAll(() => {
      kind = spinUpKind();
      const repoRoot = path.resolve(__dirname, "../../../../..");
      // Build base + codex into the kind cluster.
      execSync(
        `docker buildx bake --file ${repoRoot}/docker/agent-runtime/buildx-bake.hcl --set "base.tags=paperclipai/agent-runtime-base:test-m3b" --set "codex.tags=${IMAGE}" --set "*.platforms=linux/amd64" base codex`,
        { cwd: repoRoot, stdio: "inherit" },
      );
      execSync(`kind load docker-image ${IMAGE} --name ${kind.name}`, { stdio: "inherit" });
    }, 600_000);

    afterAll(() => kind?.cleanup());

    it("the agent-runtime-codex image boots and `codex` is on PATH", async () => {
      const client = createKubernetesApiClient({
        id: "c-1", label: "kind", kind: "kubeconfig",
        kubeconfigYaml: kind.kubeconfigYaml,
        defaultNamespacePrefix: "paperclip-",
        allowAgentImageOverride: false,
        imageAllowlist: [],
        capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      });

      // Run a Pod that just verifies `codex` is on PATH and exits.
      const podYaml = `apiVersion: v1
kind: Pod
metadata:
  name: codex-probe
  namespace: default
spec:
  restartPolicy: Never
  containers:
    - name: c
      image: ${IMAGE}
      command: ["sh", "-c", "command -v codex && echo CODEX_OK"]
`;
      const env = { ...process.env, KUBECONFIG: kind.kubeconfigPath };
      execSync(`kubectl apply -f - <<'EOF'\n${podYaml}\nEOF`, { env, shell: "/bin/bash" });
      execSync(`kubectl wait --for=condition=Ready=false --for=jsonpath='{.status.phase}'=Succeeded pod/codex-probe --timeout=60s`, { env });
      const logs = execSync(`kubectl logs pod/codex-probe`, { env }).toString();
      expect(logs).toContain("CODEX_OK");
    }, 600_000);
  },
);
```

- [ ] **Step 6: Verify the test compiles even when skipped**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest list test/integration/codex-smoke.test.ts`
Expected: lists test as skipped (no env vars set).

- [ ] **Step 7: Commit**

```bash
git add docker/agent-runtime/Dockerfile.codex \
        docker/agent-runtime/buildx-bake.hcl \
        packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts \
        packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts \
        packages/adapters/kubernetes-execution/test/integration/codex-smoke.test.ts
git commit -m "feat(k8s-execution): codex_local runtime image + smoke test"
```

---

### Task 10: gemini_local — Dockerfile + defaults entry + smoke test

**Files:**
- Create: `docker/agent-runtime/Dockerfile.gemini`
- Modify: `docker/agent-runtime/buildx-bake.hcl`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts`
- Create: `packages/adapters/kubernetes-execution/test/integration/gemini-smoke.test.ts`

- [ ] **Step 1: Add the Dockerfile**

Create `docker/agent-runtime/Dockerfile.gemini`:

```dockerfile
# syntax=docker/dockerfile:1.6
ARG BASE_TAG=dev
FROM paperclipai/agent-runtime-base:${BASE_TAG}

USER root
RUN npm install -g @google/gemini-cli@latest \
    && chown -R 1000:1000 /usr/lib/node_modules \
    || true

RUN command -v gemini >/dev/null 2>&1 || (echo "gemini not on PATH"; exit 1)

USER 1000:1000

RUN command -v gemini >/dev/null 2>&1 || (echo "gemini not on PATH"; exit 1)
```

- [ ] **Step 2: Add the bake target**

Open `docker/agent-runtime/buildx-bake.hcl`. Extend the default group:

```hcl
group "default" {
  targets = ["base", "claude", "codex", "gemini"]
}
```

Append:

```hcl
target "gemini" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.gemini"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-gemini:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}
```

- [ ] **Step 3: Add the registry entry test**

Append to `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts`:

```ts
  it("gemini_local has expected env + fqdn defaults", () => {
    const d = getAdapterDefaults("gemini_local");
    expect(d.runtimeImage).toMatch(/agent-runtime-gemini/);
    expect(d.envKeys).toEqual(expect.arrayContaining(["GEMINI_API_KEY", "GOOGLE_API_KEY"]));
    expect(d.allowFqdns).toContain("generativelanguage.googleapis.com");
  });
```

Run the test, expect FAIL.

- [ ] **Step 4: Add the registry entry**

In `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts`, add:

```ts
  gemini_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-gemini`,
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    allowFqdns: ["generativelanguage.googleapis.com"],
  },
```

Re-run, expect PASS.

- [ ] **Step 5: Write the smoke test**

Create `packages/adapters/kubernetes-execution/test/integration/gemini-smoke.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spinUpKind, type KindCluster } from "./_harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe.skipIf(!process.env["K8S_INTEGRATION"])(
  "gemini_local runtime image smoke",
  () => {
    let kind: KindCluster;
    const IMAGE = "paperclipai/agent-runtime-gemini:test-m3b";

    beforeAll(() => {
      kind = spinUpKind();
      const repoRoot = path.resolve(__dirname, "../../../../..");
      execSync(
        `docker buildx bake --file ${repoRoot}/docker/agent-runtime/buildx-bake.hcl --set "base.tags=paperclipai/agent-runtime-base:test-m3b" --set "gemini.tags=${IMAGE}" --set "*.platforms=linux/amd64" base gemini`,
        { cwd: repoRoot, stdio: "inherit" },
      );
      execSync(`kind load docker-image ${IMAGE} --name ${kind.name}`, { stdio: "inherit" });
    }, 600_000);

    afterAll(() => kind?.cleanup());

    it("the agent-runtime-gemini image boots and `gemini` is on PATH", async () => {
      const podYaml = `apiVersion: v1
kind: Pod
metadata:
  name: gemini-probe
  namespace: default
spec:
  restartPolicy: Never
  containers:
    - name: c
      image: ${IMAGE}
      command: ["sh", "-c", "command -v gemini && echo GEMINI_OK"]
`;
      const env = { ...process.env, KUBECONFIG: kind.kubeconfigPath };
      execSync(`kubectl apply -f - <<'EOF'\n${podYaml}\nEOF`, { env, shell: "/bin/bash" });
      execSync(`kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/gemini-probe --timeout=60s`, { env });
      const logs = execSync(`kubectl logs pod/gemini-probe`, { env }).toString();
      expect(logs).toContain("GEMINI_OK");
    }, 600_000);
  },
);
```

- [ ] **Step 6: Verify compile + commit**

```bash
pnpm --filter @paperclipai/execution-target-kubernetes exec vitest list test/integration/gemini-smoke.test.ts
git add docker/agent-runtime/Dockerfile.gemini \
        docker/agent-runtime/buildx-bake.hcl \
        packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts \
        packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts \
        packages/adapters/kubernetes-execution/test/integration/gemini-smoke.test.ts
git commit -m "feat(k8s-execution): gemini_local runtime image + smoke test"
```

---

### Task 11: acpx_local — Dockerfile + defaults entry + smoke test

**Files:**
- Create: `docker/agent-runtime/Dockerfile.acpx`
- Modify: `docker/agent-runtime/buildx-bake.hcl`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts`
- Create: `packages/adapters/kubernetes-execution/test/integration/acpx-smoke.test.ts`

acpx_local is the ACPX adapter — it bridges between Anthropic and OpenAI (per `packages/adapters/acpx-local/src/server/test.ts` it requires either `ANTHROPIC_API_KEY` for Claude or `OPENAI_API_KEY` for Codex).

- [ ] **Step 1: Add the Dockerfile**

Create `docker/agent-runtime/Dockerfile.acpx`:

```dockerfile
# syntax=docker/dockerfile:1.6
ARG BASE_TAG=dev
FROM paperclipai/agent-runtime-base:${BASE_TAG}

USER root
# acpx-cli is the ACPX wrapper. Verify the package name in the local adapter:
# packages/adapters/acpx-local/src/server/execute.ts. Adjust if the upstream
# binary is published under a different npm name.
RUN npm install -g acpx-cli@latest \
    && chown -R 1000:1000 /usr/lib/node_modules \
    || true

RUN command -v acpx >/dev/null 2>&1 || (echo "acpx not on PATH"; exit 1)

USER 1000:1000

RUN command -v acpx >/dev/null 2>&1 || (echo "acpx not on PATH"; exit 1)
```

- [ ] **Step 2: Add the bake target**

Extend `group "default"` in `docker/agent-runtime/buildx-bake.hcl`:

```hcl
group "default" {
  targets = ["base", "claude", "codex", "gemini", "acpx"]
}
```

Append:

```hcl
target "acpx" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.acpx"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-acpx:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}
```

- [ ] **Step 3: Add the registry entry test**

Append to `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts`:

```ts
  it("acpx_local has expected env + fqdn defaults", () => {
    const d = getAdapterDefaults("acpx_local");
    expect(d.runtimeImage).toMatch(/agent-runtime-acpx/);
    expect(d.envKeys).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]));
    expect(d.allowFqdns).toEqual(expect.arrayContaining(["api.anthropic.com", "api.openai.com"]));
  });
```

- [ ] **Step 4: Add the registry entry**

In `adapter-defaults.ts`:

```ts
  acpx_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-acpx`,
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    allowFqdns: ["api.anthropic.com", "api.openai.com"],
  },
```

Run the test, expect PASS.

- [ ] **Step 5: Write the smoke test**

Create `packages/adapters/kubernetes-execution/test/integration/acpx-smoke.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spinUpKind, type KindCluster } from "./_harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe.skipIf(!process.env["K8S_INTEGRATION"])(
  "acpx_local runtime image smoke",
  () => {
    let kind: KindCluster;
    const IMAGE = "paperclipai/agent-runtime-acpx:test-m3b";

    beforeAll(() => {
      kind = spinUpKind();
      const repoRoot = path.resolve(__dirname, "../../../../..");
      execSync(
        `docker buildx bake --file ${repoRoot}/docker/agent-runtime/buildx-bake.hcl --set "base.tags=paperclipai/agent-runtime-base:test-m3b" --set "acpx.tags=${IMAGE}" --set "*.platforms=linux/amd64" base acpx`,
        { cwd: repoRoot, stdio: "inherit" },
      );
      execSync(`kind load docker-image ${IMAGE} --name ${kind.name}`, { stdio: "inherit" });
    }, 600_000);

    afterAll(() => kind?.cleanup());

    it("the agent-runtime-acpx image boots and `acpx` is on PATH", async () => {
      const podYaml = `apiVersion: v1
kind: Pod
metadata:
  name: acpx-probe
  namespace: default
spec:
  restartPolicy: Never
  containers:
    - name: c
      image: ${IMAGE}
      command: ["sh", "-c", "command -v acpx && echo ACPX_OK"]
`;
      const env = { ...process.env, KUBECONFIG: kind.kubeconfigPath };
      execSync(`kubectl apply -f - <<'EOF'\n${podYaml}\nEOF`, { env, shell: "/bin/bash" });
      execSync(`kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/acpx-probe --timeout=60s`, { env });
      const logs = execSync(`kubectl logs pod/acpx-probe`, { env }).toString();
      expect(logs).toContain("ACPX_OK");
    }, 600_000);
  },
);
```

- [ ] **Step 6: Verify compile + commit**

```bash
pnpm --filter @paperclipai/execution-target-kubernetes exec vitest list test/integration/acpx-smoke.test.ts
git add docker/agent-runtime/Dockerfile.acpx \
        docker/agent-runtime/buildx-bake.hcl \
        packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts \
        packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts \
        packages/adapters/kubernetes-execution/test/integration/acpx-smoke.test.ts
git commit -m "feat(k8s-execution): acpx_local runtime image + smoke test"
```

---

### Task 12: opencode_local — Dockerfile + defaults entry + smoke test

**Files:**
- Create: `docker/agent-runtime/Dockerfile.opencode`
- Modify: `docker/agent-runtime/buildx-bake.hcl`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts`
- Create: `packages/adapters/kubernetes-execution/test/integration/opencode-smoke.test.ts`

opencode_local takes `OPENAI_API_KEY` per `packages/adapters/opencode-local/src/server/test.ts` and reaches `api.openai.com`.

- [ ] **Step 1: Add the Dockerfile**

Create `docker/agent-runtime/Dockerfile.opencode`:

```dockerfile
# syntax=docker/dockerfile:1.6
ARG BASE_TAG=dev
FROM paperclipai/agent-runtime-base:${BASE_TAG}

USER root
RUN npm install -g opencode-ai@latest \
    && chown -R 1000:1000 /usr/lib/node_modules \
    || true

RUN command -v opencode >/dev/null 2>&1 || (echo "opencode not on PATH"; exit 1)

USER 1000:1000

RUN command -v opencode >/dev/null 2>&1 || (echo "opencode not on PATH"; exit 1)
```

- [ ] **Step 2: Add the bake target**

Extend `group "default"`:

```hcl
group "default" {
  targets = ["base", "claude", "codex", "gemini", "acpx", "opencode"]
}
```

Append:

```hcl
target "opencode" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.opencode"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-opencode:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}
```

- [ ] **Step 3: Add the registry entry test**

Append to `adapter-defaults.test.ts`:

```ts
  it("opencode_local has expected env + fqdn defaults", () => {
    const d = getAdapterDefaults("opencode_local");
    expect(d.runtimeImage).toMatch(/agent-runtime-opencode/);
    expect(d.envKeys).toContain("OPENAI_API_KEY");
    expect(d.allowFqdns).toContain("api.openai.com");
  });
```

- [ ] **Step 4: Add the registry entry**

In `adapter-defaults.ts`:

```ts
  opencode_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-opencode`,
    envKeys: ["OPENAI_API_KEY"],
    allowFqdns: ["api.openai.com"],
  },
```

Run the test, expect PASS.

- [ ] **Step 5: Write the smoke test**

Create `packages/adapters/kubernetes-execution/test/integration/opencode-smoke.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spinUpKind, type KindCluster } from "./_harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe.skipIf(!process.env["K8S_INTEGRATION"])(
  "opencode_local runtime image smoke",
  () => {
    let kind: KindCluster;
    const IMAGE = "paperclipai/agent-runtime-opencode:test-m3b";

    beforeAll(() => {
      kind = spinUpKind();
      const repoRoot = path.resolve(__dirname, "../../../../..");
      execSync(
        `docker buildx bake --file ${repoRoot}/docker/agent-runtime/buildx-bake.hcl --set "base.tags=paperclipai/agent-runtime-base:test-m3b" --set "opencode.tags=${IMAGE}" --set "*.platforms=linux/amd64" base opencode`,
        { cwd: repoRoot, stdio: "inherit" },
      );
      execSync(`kind load docker-image ${IMAGE} --name ${kind.name}`, { stdio: "inherit" });
    }, 600_000);

    afterAll(() => kind?.cleanup());

    it("the agent-runtime-opencode image boots and `opencode` is on PATH", async () => {
      const podYaml = `apiVersion: v1
kind: Pod
metadata:
  name: opencode-probe
  namespace: default
spec:
  restartPolicy: Never
  containers:
    - name: c
      image: ${IMAGE}
      command: ["sh", "-c", "command -v opencode && echo OPENCODE_OK"]
`;
      const env = { ...process.env, KUBECONFIG: kind.kubeconfigPath };
      execSync(`kubectl apply -f - <<'EOF'\n${podYaml}\nEOF`, { env, shell: "/bin/bash" });
      execSync(`kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/opencode-probe --timeout=60s`, { env });
      const logs = execSync(`kubectl logs pod/opencode-probe`, { env }).toString();
      expect(logs).toContain("OPENCODE_OK");
    }, 600_000);
  },
);
```

- [ ] **Step 6: Verify compile + commit**

```bash
pnpm --filter @paperclipai/execution-target-kubernetes exec vitest list test/integration/opencode-smoke.test.ts
git add docker/agent-runtime/Dockerfile.opencode \
        docker/agent-runtime/buildx-bake.hcl \
        packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts \
        packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts \
        packages/adapters/kubernetes-execution/test/integration/opencode-smoke.test.ts
git commit -m "feat(k8s-execution): opencode_local runtime image + smoke test"
```

---

### Task 13: pi_local — Dockerfile + defaults entry + smoke test

**Files:**
- Create: `docker/agent-runtime/Dockerfile.pi`
- Modify: `docker/agent-runtime/buildx-bake.hcl`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts`
- Create: `packages/adapters/kubernetes-execution/test/integration/pi-smoke.test.ts`

pi_local is a multi-provider router (per `packages/adapters/pi-local/src/server/test.ts` it accepts `ANTHROPIC_API_KEY`, `XAI_API_KEY`, etc.). Defaults pre-allow Anthropic, OpenAI, and X.AI; operators add more via `additionalAllowFqdns`.

- [ ] **Step 1: Add the Dockerfile**

Create `docker/agent-runtime/Dockerfile.pi`:

```dockerfile
# syntax=docker/dockerfile:1.6
ARG BASE_TAG=dev
FROM paperclipai/agent-runtime-base:${BASE_TAG}

USER root
# pi-cli is the multi-provider Pi router. Verify the npm package name in
# packages/adapters/pi-local/src/server/execute.ts; adjust if upstream
# publishes under a different name.
RUN npm install -g pi-cli@latest \
    && chown -R 1000:1000 /usr/lib/node_modules \
    || true

RUN command -v pi >/dev/null 2>&1 || (echo "pi not on PATH"; exit 1)

USER 1000:1000

RUN command -v pi >/dev/null 2>&1 || (echo "pi not on PATH"; exit 1)
```

- [ ] **Step 2: Add the bake target**

Extend `group "default"`:

```hcl
group "default" {
  targets = ["base", "claude", "codex", "gemini", "acpx", "opencode", "pi"]
}
```

Append:

```hcl
target "pi" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.pi"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-pi:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}
```

- [ ] **Step 3: Add the registry entry test**

Append to `adapter-defaults.test.ts`:

```ts
  it("pi_local has expected env + fqdn defaults", () => {
    const d = getAdapterDefaults("pi_local");
    expect(d.runtimeImage).toMatch(/agent-runtime-pi/);
    expect(d.envKeys).toEqual(
      expect.arrayContaining(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"]),
    );
    expect(d.allowFqdns).toEqual(
      expect.arrayContaining(["api.anthropic.com", "api.openai.com", "api.x.ai"]),
    );
  });
```

- [ ] **Step 4: Add the registry entry**

In `adapter-defaults.ts`:

```ts
  pi_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-pi`,
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"],
    allowFqdns: ["api.anthropic.com", "api.openai.com", "api.x.ai"],
  },
```

Run the test, expect PASS.

- [ ] **Step 5: Write the smoke test**

Create `packages/adapters/kubernetes-execution/test/integration/pi-smoke.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spinUpKind, type KindCluster } from "./_harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe.skipIf(!process.env["K8S_INTEGRATION"])(
  "pi_local runtime image smoke",
  () => {
    let kind: KindCluster;
    const IMAGE = "paperclipai/agent-runtime-pi:test-m3b";

    beforeAll(() => {
      kind = spinUpKind();
      const repoRoot = path.resolve(__dirname, "../../../../..");
      execSync(
        `docker buildx bake --file ${repoRoot}/docker/agent-runtime/buildx-bake.hcl --set "base.tags=paperclipai/agent-runtime-base:test-m3b" --set "pi.tags=${IMAGE}" --set "*.platforms=linux/amd64" base pi`,
        { cwd: repoRoot, stdio: "inherit" },
      );
      execSync(`kind load docker-image ${IMAGE} --name ${kind.name}`, { stdio: "inherit" });
    }, 600_000);

    afterAll(() => kind?.cleanup());

    it("the agent-runtime-pi image boots and `pi` is on PATH", async () => {
      const podYaml = `apiVersion: v1
kind: Pod
metadata:
  name: pi-probe
  namespace: default
spec:
  restartPolicy: Never
  containers:
    - name: c
      image: ${IMAGE}
      command: ["sh", "-c", "command -v pi && echo PI_OK"]
`;
      const env = { ...process.env, KUBECONFIG: kind.kubeconfigPath };
      execSync(`kubectl apply -f - <<'EOF'\n${podYaml}\nEOF`, { env, shell: "/bin/bash" });
      execSync(`kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/pi-probe --timeout=60s`, { env });
      const logs = execSync(`kubectl logs pod/pi-probe`, { env }).toString();
      expect(logs).toContain("PI_OK");
    }, 600_000);
  },
);
```

- [ ] **Step 6: Verify compile + commit**

```bash
pnpm --filter @paperclipai/execution-target-kubernetes exec vitest list test/integration/pi-smoke.test.ts
git add docker/agent-runtime/Dockerfile.pi \
        docker/agent-runtime/buildx-bake.hcl \
        packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts \
        packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts \
        packages/adapters/kubernetes-execution/test/integration/pi-smoke.test.ts
git commit -m "feat(k8s-execution): pi_local runtime image + smoke test"
```

---

### Task 14: hermes_local — Dockerfile (stub) + defaults entry + smoke test

**Files:**
- Create: `docker/agent-runtime/Dockerfile.hermes`
- Modify: `docker/agent-runtime/buildx-bake.hcl`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts`
- Create: `packages/adapters/kubernetes-execution/test/integration/hermes-smoke.test.ts`

**hermes_local has no `packages/adapters/hermes-local/` package**, only an entry in `LEGACY_SESSIONED_ADAPTER_TYPES`. The Dockerfile is a stub that documents the gap; the smoke test verifies the image boots but does NOT verify a `hermes` binary is on PATH (because no upstream binary is identified).

- [ ] **Step 1: Add the stub Dockerfile**

Create `docker/agent-runtime/Dockerfile.hermes`:

```dockerfile
# syntax=docker/dockerfile:1.6
ARG BASE_TAG=dev
FROM paperclipai/agent-runtime-base:${BASE_TAG}

# hermes_local is in the legacy sessioned-adapter set but has no upstream
# npm package wired into Paperclip locally yet (see
# packages/adapter-utils/src/session-compaction.ts vs the absent
# packages/adapters/hermes-local/). This stub image preserves a cloud
# runtime slot for hermes_local; whoever ports the hermes binary to
# Paperclip locally adds the `npm install -g <pkg>` and the PATH check
# to this Dockerfile.
#
# Until then, runs targeting hermes_local on the cloud adapter will boot
# the container but `agent-shim` will fail with "hermes not on PATH" when
# it tries to invoke the CLI.

USER 1000:1000
```

- [ ] **Step 2: Add the bake target**

Extend `group "default"`:

```hcl
group "default" {
  targets = ["base", "claude", "codex", "gemini", "acpx", "opencode", "pi", "hermes"]
}
```

Append:

```hcl
target "hermes" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.hermes"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = ["${REGISTRY}/agent-runtime-hermes:${VERSION}"]
  contexts = {
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
  }
}
```

- [ ] **Step 3: Add the registry entry test**

Append to `adapter-defaults.test.ts`:

```ts
  it("hermes_local registry entry exists with a runtime image (binary install is a follow-up)", () => {
    const d = getAdapterDefaults("hermes_local");
    expect(d.runtimeImage).toMatch(/agent-runtime-hermes/);
    // Empty envKeys / allowFqdns until upstream binary lands; operators set
    // their own via cluster_tenant_policies.networkJson.additionalAllowFqdns
    // and the per-Job env Secret.
    expect(d.envKeys).toEqual([]);
    expect(d.allowFqdns).toEqual([]);
  });
```

- [ ] **Step 4: Add the registry entry**

In `adapter-defaults.ts`:

```ts
  hermes_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-hermes`,
    // Empty defaults: no upstream npm binary identified yet. See
    // Dockerfile.hermes for the gap and the path forward.
    envKeys: [],
    allowFqdns: [],
  },
```

Run the test, expect PASS.

- [ ] **Step 5: Write the smoke test**

Create `packages/adapters/kubernetes-execution/test/integration/hermes-smoke.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spinUpKind, type KindCluster } from "./_harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe.skipIf(!process.env["K8S_INTEGRATION"])(
  "hermes_local runtime image smoke (stub — no upstream binary yet)",
  () => {
    let kind: KindCluster;
    const IMAGE = "paperclipai/agent-runtime-hermes:test-m3b";

    beforeAll(() => {
      kind = spinUpKind();
      const repoRoot = path.resolve(__dirname, "../../../../..");
      execSync(
        `docker buildx bake --file ${repoRoot}/docker/agent-runtime/buildx-bake.hcl --set "base.tags=paperclipai/agent-runtime-base:test-m3b" --set "hermes.tags=${IMAGE}" --set "*.platforms=linux/amd64" base hermes`,
        { cwd: repoRoot, stdio: "inherit" },
      );
      execSync(`kind load docker-image ${IMAGE} --name ${kind.name}`, { stdio: "inherit" });
    }, 600_000);

    afterAll(() => kind?.cleanup());

    it("the agent-runtime-hermes image boots (no CLI installed yet)", async () => {
      // We don't assert `command -v hermes` because the upstream binary is
      // not yet identified. We only verify the image starts and exits 0
      // when running `true`. When the binary lands in a follow-up, change
      // this to mirror the codex/gemini smoke tests.
      const podYaml = `apiVersion: v1
kind: Pod
metadata:
  name: hermes-probe
  namespace: default
spec:
  restartPolicy: Never
  containers:
    - name: c
      image: ${IMAGE}
      command: ["sh", "-c", "echo HERMES_BOOT_OK"]
`;
      const env = { ...process.env, KUBECONFIG: kind.kubeconfigPath };
      execSync(`kubectl apply -f - <<'EOF'\n${podYaml}\nEOF`, { env, shell: "/bin/bash" });
      execSync(`kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/hermes-probe --timeout=60s`, { env });
      const logs = execSync(`kubectl logs pod/hermes-probe`, { env }).toString();
      expect(logs).toContain("HERMES_BOOT_OK");
    }, 600_000);
  },
);
```

- [ ] **Step 6: Verify compile + commit**

```bash
pnpm --filter @paperclipai/execution-target-kubernetes exec vitest list test/integration/hermes-smoke.test.ts
git add docker/agent-runtime/Dockerfile.hermes \
        docker/agent-runtime/buildx-bake.hcl \
        packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts \
        packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts \
        packages/adapters/kubernetes-execution/test/integration/hermes-smoke.test.ts
git commit -m "feat(k8s-execution): hermes_local runtime image stub + smoke test"
```

---

### Task 15: Wire adapter defaults into the driver

**Files:**
- Modify: `packages/adapters/kubernetes-execution/src/driver.ts`
- Modify: `packages/adapters/kubernetes-execution/test/unit/driver-run.test.ts`

**Goal:** Use the `adapter-defaults` registry from inside `driver.run()` so each adapter type automatically gets its envKeys exposed (from the per-Job Secret) and its allowFqdns added to the Cilium baseline. Server callers don't need to repeat the per-adapter knowledge.

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/kubernetes-execution/test/unit/driver-run.test.ts`:

```ts
  it("merges getAdapterDefaults().allowFqdns into ensureTenant's adapterAllowFqdns", async () => {
    const ensureSpy = vi.fn(async () => ({ namespace: "paperclip-x", ciliumApplied: false }));
    const driver = makeFakeDriver({
      ensureTenantOverride: ensureSpy,
      ctxAdapterType: "codex_local",
    });
    await driver.run({ ctx: makeCtx({ adapterType: "codex_local" }), target: { clusterConnectionId: "c-1" } });
    const calls = ensureSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const passedFqdns = calls[0][0].adapterAllowFqdns ?? calls[0][1]?.adapterAllowFqdns;
    expect(passedFqdns).toContain("api.openai.com");
  });

  it("exposes getAdapterDefaults().envKeys via the per-Job Secret", async () => {
    const secretSpy = vi.fn(async () => undefined);
    const driver = makeFakeDriver({
      applyEphemeralSecretOverride: secretSpy,
      ctxAdapterType: "gemini_local",
      // Inject a fake env-secret resolver returning known keys.
      envSecretResolverOverride: async () => ({
        GEMINI_API_KEY: "gem-test",
        GOOGLE_API_KEY: "google-test",
        ANTHROPIC_API_KEY: "anth-irrelevant",
      }),
    });
    await driver.run({ ctx: makeCtx({ adapterType: "gemini_local" }), target: { clusterConnectionId: "c-1" } });
    // Inspect the data shape the secret-builder receives.
    const builtSecretData = secretSpy.mock.calls[0][1]?.data ?? secretSpy.mock.calls[0][0]?.data;
    expect(Object.keys(builtSecretData)).toEqual(expect.arrayContaining(["GEMINI_API_KEY", "GOOGLE_API_KEY"]));
    // ANTHROPIC_API_KEY is not in gemini_local's envKeys → not exposed.
    expect(Object.keys(builtSecretData)).not.toContain("ANTHROPIC_API_KEY");
  });
```

The exact helper plumbing depends on the existing `makeFakeDriver` shape. If the helpers don't accept `ctxAdapterType`, `ensureTenantOverride`, or `applyEphemeralSecretOverride`, extend them by reading the surrounding test code and following its patterns. The point is: assert that adapter-defaults are read from the registry and threaded into ensureTenant + the env Secret.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run test/unit/driver-run.test.ts`
Expected: 2 new FAILs.

- [ ] **Step 3: Wire the registry into the driver**

In `packages/adapters/kubernetes-execution/src/driver.ts`:

a) Add the import:

```ts
import { getAdapterDefaults } from "./orchestrator/adapter-defaults.js";
```

b) In `run()`, after `runContext` is resolved, look up the defaults:

```ts
        const adapterType = ctx.agent.adapterType ?? "unknown";
        const defaults = getAdapterDefaults(adapterType);
```

c) When building `adapterAllowFqdns` for `ensureTenant`, MERGE the registry FQDNs:

Find the existing `adapterAllowFqdns:` site (it's passed into `ensureTenantNamespace` in M2). Replace whatever it currently uses with:

```ts
          adapterAllowFqdns: Array.from(new Set([
            ...(runContext.adapterAllowFqdns ?? []),
            ...defaults.allowFqdns,
          ])),
```

d) When building the env Secret data, FILTER to keys defaults.envKeys:

Find the secret-data assembly (probably a `Record<string, string>` built from `runContext.adapterEnv`). Restrict it to defaults.envKeys:

```ts
        const adapterEnv = { ...(runContext.adapterEnv ?? {}) };
        const filteredAdapterEnv: Record<string, string> = {};
        for (const k of defaults.envKeys) {
          if (typeof adapterEnv[k] === "string") filteredAdapterEnv[k] = adapterEnv[k];
        }
        // Plus required keys the agent-shim itself uses (BOOTSTRAP_TOKEN etc.)
        // — those are not in the per-adapter list, they're per-run.
```

Then use `filteredAdapterEnv` when building the secret instead of `adapterEnv`.

(If the existing M2 code uses a wider set of keys like ANTHROPIC_API_KEY hardcoded for claude_local, this filter REPLACES that hardcoding — the registry is now the single source of truth.)

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run test/unit/driver-run.test.ts`
Expected: PASS, including the 2 new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/driver.ts \
        packages/adapters/kubernetes-execution/test/unit/driver-run.test.ts
git commit -m "feat(k8s-execution): driver consumes adapter-defaults registry for env+FQDNs"
```

---

### Task 16: Adapter coverage docs

**Files:**
- Create: `docs/k8s-execution/adapters.md`

- [ ] **Step 1: Write the doc**

Create `docs/k8s-execution/adapters.md`:

```markdown
# Cloud-runtime adapter coverage

The Kubernetes execution target ships a per-adapter runtime image for each
local adapter Paperclip supports. The image is selected at run time by
`adapter-defaults.ts:getAdapterDefaults()`, which also lists which env keys
the driver exposes from the per-Job Secret and which FQDNs the tenant
NetworkPolicy + Cilium baseline must permit egress to.

| Adapter type      | Runtime image                                           | Env keys                                          | Default allowed FQDNs                                                  |
|-------------------|---------------------------------------------------------|---------------------------------------------------|------------------------------------------------------------------------|
| `claude_local`    | `ghcr.io/paperclipai/agent-runtime-claude`              | `ANTHROPIC_API_KEY`                               | `api.anthropic.com`                                                    |
| `codex_local`     | `ghcr.io/paperclipai/agent-runtime-codex`               | `OPENAI_API_KEY`                                  | `api.openai.com`                                                       |
| `gemini_local`    | `ghcr.io/paperclipai/agent-runtime-gemini`              | `GEMINI_API_KEY`, `GOOGLE_API_KEY`                | `generativelanguage.googleapis.com`                                    |
| `acpx_local`      | `ghcr.io/paperclipai/agent-runtime-acpx`                | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`             | `api.anthropic.com`, `api.openai.com`                                  |
| `opencode_local`  | `ghcr.io/paperclipai/agent-runtime-opencode`            | `OPENAI_API_KEY`                                  | `api.openai.com`                                                       |
| `pi_local`        | `ghcr.io/paperclipai/agent-runtime-pi`                  | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | `api.anthropic.com`, `api.openai.com`, `api.x.ai`                  |
| `hermes_local`    | `ghcr.io/paperclipai/agent-runtime-hermes` (stub)       | _(none — upstream binary not yet wired)_          | _(none — operators set via tenant policy)_                             |

## Per-tenant overrides

Operators can extend (not restrict — that's
`docs/k8s-execution/cilium-recipes.md`) the egress allow-list by setting
`additionalAllowFqdns` on the tenant policy:

```bash
# Add a custom Anthropic-compatible endpoint to the claude_local default.
paperclip cluster set-tenant-policy \
  --cluster <id> --company <id> \
  --additional-allow-fqdns "claude-proxy.acme.internal"
```

The per-tenant FQDNs are MERGED with the adapter defaults; the resulting
NetworkPolicy + Cilium baseline allows BOTH.

## Building the runtime images

The full set of runtime images is built via Docker buildx bake:

```bash
docker buildx bake --file docker/agent-runtime/buildx-bake.hcl \
  --set "*.platforms=linux/amd64,linux/arm64" \
  default
```

Individual targets: `base`, `claude`, `codex`, `gemini`, `acpx`,
`opencode`, `pi`, `hermes`.

## Adding a new adapter

1. Add a `Dockerfile.<adapter>` extending `agent-runtime-base`.
2. Add the bake target in `docker/agent-runtime/buildx-bake.hcl` and
   include it in `group "default"`.
3. Add a `<adapter>_local: { runtimeImage, envKeys, allowFqdns }` entry to
   `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts`.
4. Add a unit test in `adapter-defaults.test.ts` and a smoke test in
   `test/integration/<adapter>-smoke.test.ts`.
5. Update this table.
```

- [ ] **Step 2: Commit**

```bash
git add docs/k8s-execution/adapters.md
git commit -m "docs(k8s-execution): adapter coverage table + 'how to add a new adapter' guide"
```

---

## Phase D — Closeout (Tasks 17–18)

### Task 17: M3b CHANGELOG entry

**Files:**
- Modify: `docs/k8s-execution/CHANGELOG.md`

- [ ] **Step 1: Append the entry**

Add at the top of `docs/k8s-execution/CHANGELOG.md` (after the file's H1, before the existing M3a entry):

```markdown
## M3b — 2026-05-09

Production hardening of the Kubernetes execution path:

- **Cross-replica Redis rate limiting.** New `createRedisSlidingWindowLimiter` backed by an atomic `EVAL` over Redis sorted sets. Factory in `k8s-callback.ts` picks Redis-backed when `PAPERCLIP_REDIS_URL` is set, otherwise falls back to the in-memory limiter (single-replica only). Documented in `security-model.md`.
- **Per-cluster image allow-list.** New `image_allowlist text[]` column on `cluster_connections`. Driver enforces prefix-match on both the resolved adapter image and any `target.imageOverride` before launching the Job; rejects with `errorCode: "image_not_allowed"`. New CLI subcommand `paperclip cluster set-image-allowlist`.
- **Six new cloud-runtime adapter images:** `agent-runtime-codex`, `-gemini`, `-acpx`, `-opencode`, `-pi`, `-hermes`. Each has a Dockerfile, buildx-bake target, and busybox-style smoke test. The per-adapter env keys + default FQDN allow-list live in `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts` (single source of truth used by the driver).
- **Schema migration `0085`** adds the `image_allowlist` column.

`hermes_local` ships as a stub Dockerfile because no upstream npm binary is wired into Paperclip locally yet (see `Dockerfile.hermes` for the gap and path forward).
```

- [ ] **Step 2: Commit**

```bash
git add docs/k8s-execution/CHANGELOG.md
git commit -m "docs(k8s-execution): M3b changelog entry"
```

---

### Task 18: Open the PR

**Files:** none — command-only.

- [ ] **Step 1: Push the branch**

```bash
git push -u stubbi feat/k8s-cloud-adapter-m3b
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create \
  --repo paperclipai/paperclip \
  --base master \
  --head stubbi:feat/k8s-cloud-adapter-m3b \
  --title "feat(k8s-execution): M3b — Redis rate limiter, image allow-list, multi-adapter coverage" \
  --body "$(cat <<'EOF'
## Thinking Path

> Tactical PR per the M3b spec (`docs/superpowers/specs/2026-05-09-paperclip-cloud-adapter-m3b-spec.md`). Three independent items in one PR: cross-replica Redis rate limiter, per-cluster image allow-list, and runtime-image coverage for the six remaining local adapters. One migration (`0085`), no new package.

## What Changed

### Cross-replica Redis rate limit
- New atomic Lua-script-backed limiter at `server/src/routes/_limiter-redis.ts`.
- Factory in `k8s-callback.ts` picks impl based on `PAPERCLIP_REDIS_URL`.
- In-memory fallback preserved for dev / single-replica.
- Documented in `docs/k8s-execution/security-model.md`.

### Per-cluster image allow-list
- Migration `0085_cluster_image_allowlist.sql` adds `image_allowlist text[] NOT NULL DEFAULT ARRAY[]::text[]`.
- `driver.run()` enforces prefix-match before `createAgentJob`. Rejects with `errorCode: "image_not_allowed"`.
- Empty allow-list preserves existing `allowAgentImageOverride` boolean semantics — additive, no behavior change for existing rows.
- New CLI subcommand `paperclip cluster set-image-allowlist`.

### Multi-adapter coverage
- Six new runtime images: `agent-runtime-{codex,gemini,acpx,opencode,pi,hermes}`.
- Per-adapter Dockerfile + buildx-bake target + busybox-style smoke test.
- Single source of truth for per-adapter env keys + FQDN defaults at `adapter-defaults.ts:ADAPTER_DEFAULTS`. Driver consumes it; server side stays adapter-agnostic.
- `hermes_local` ships as a stub because no upstream npm binary is identified yet — documented in `Dockerfile.hermes` and the spec.
- New doc at `docs/k8s-execution/adapters.md`.

## Verification

- [x] `pnpm --filter @paperclipai/db build` (migration 0085 applies cleanly)
- [x] `pnpm --filter @paperclipai/server typecheck` passes
- [x] `pnpm --filter @paperclipai/server test` passes (incl. new Redis limiter tests)
- [x] `pnpm --filter paperclipai test` passes (incl. new CLI subcommand tests)
- [x] `pnpm --filter @paperclipai/execution-target-kubernetes test` passes (incl. driver allow-list + adapter-defaults tests)
- [ ] `K8S_INTEGRATION=1 vitest run test/integration/<adapter>-smoke.test.ts` for each of {codex, gemini, acpx, opencode, pi, hermes} — operator runs out-of-band
- [ ] Multi-replica deployment with `PAPERCLIP_REDIS_URL` set: rate limit holds across replicas (operator validates)

## Risks & Rollback

- Migration 0085 is purely additive; reversible via `DROP COLUMN`.
- Image allow-list defaults to `[]` so existing deployments see no behavior change.
- Redis fail-open: blips admit requests rather than 500ing endpoints.
- Adapter env mapping is now centralized in the registry. If an adapter previously had hardcoded env handling in M2, the driver wiring change in Task 15 may surface a difference; the unit tests cover the merge semantics.

## Stack

This PR layers on **#5565 (M3a)** which layers on **#5558 (M2)** which layers on **#5556 (M1)**. Diff against `master` will include all four PRs' commits until they merge; once they do, the diff narrows to ~30–40 M3b commits.

## Model Used

- Provider: Anthropic
- Model ID: claude-opus-4-7 (1M context)
- Reasoning mode: standard

## Checklist

- [x] Spec coverage: all three sections (§1 Redis, §2 image allow-list, §3 multi-adapter)
- [x] One migration (`0085`), one column, additive
- [x] No new package; all changes in existing packages
- [x] Six new runtime images; one new docs page (`adapters.md`); one new docs section (Production rate limiting)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Add reviewers** per repo conventions.

---

## Self-Review

### Spec coverage

| Spec section | Task(s) |
|--------------|---------|
| §1 Redis rate limiter — Lua script + sorted set | Task 1 |
| §1 Factory pick on PAPERCLIP_REDIS_URL | Task 2 |
| §1 Documented in security-model.md | Task 3 |
| §2 Migration adding image_allowlist column | Task 4 |
| §2 Server service surface | Task 5 |
| §2 Driver enforcement before createAgentJob | Task 6 |
| §2 CLI subcommand `set-image-allowlist` | Task 7 |
| §3 Adapter-defaults registry | Task 8 |
| §3 codex_local | Task 9 |
| §3 gemini_local | Task 10 |
| §3 acpx_local | Task 11 |
| §3 opencode_local | Task 12 |
| §3 pi_local | Task 13 |
| §3 hermes_local (stub) | Task 14 |
| §3 Driver consumes the registry | Task 15 |
| §3 Adapter coverage docs | Task 16 |
| Cross-cutting CHANGELOG | Task 17 |
| PR open | Task 18 |

All spec sections have ≥1 task. The `image_not_allowed` errorCode literal extension to `AdapterExecutionResult` (Task 6) is the only cross-package surface change beyond the per-adapter registry.

### Placeholder scan

- No `TBD` / `TODO` / `implement later` text in the plan body.
- The hermes Dockerfile + smoke test is explicitly framed as a stub with documented gap, not a placeholder. This is intentional and called out in §3 of the spec.
- npm package names for `acpx-cli`, `pi-cli`, `opencode-ai` are best-guesses based on the local adapter conventions; Task 11/12/13 each include a "verify name in packages/adapters/<adapter>-local/src/server/execute.ts; adjust if upstream publishes under a different name" instruction. This is documented operator-driven verification, not a plan-level placeholder.

### Type consistency

- `SlidingWindowLimiter` interface introduced in Task 1 (extracted to `_limiter-types.ts`) is consumed in Task 2 (factory) — matching `consume(key)` + `stop()` signatures, with the union of sync vs async return types explicit.
- `imageAllowlist: string[]` is the single name used in: schema (Task 4), service `mapRow` (Task 5), `ResolvedClusterConnection` type (Task 5), driver enforcement (Task 6), CLI subcommand (Task 7).
- `AdapterDefaults` interface from Task 8 (`runtimeImage`, `envKeys`, `allowFqdns`) is used verbatim in Tasks 9–14 + Task 15.
- `errorCode: "image_not_allowed"` literal is introduced in Task 6 and extends the existing `AdapterExecutionResult` union — same string used in tests + docs.

No type drift detected.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-paperclip-cloud-adapter-m3b-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review between tasks. Tasks 1, 2, 4, 5, 6, 7, 8 are mostly mechanical (cheap model). Task 15 (driver wiring) needs a standard model. Tasks 9–14 are six near-identical adapter rollouts that can be dispatched sequentially.
2. **Inline Execution** — execute tasks in this session in order with batched checkpoints.

Which approach?

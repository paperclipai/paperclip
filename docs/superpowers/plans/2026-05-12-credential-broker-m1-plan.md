# Credential Broker — Milestone 1: Plumbing & Contract (Behavior-Neutral)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the contract surfaces that the credential broker depends on — the optional `credentialDelivery` field on `AdapterConfig`, the `registerCredentialBroker()` plugin SDK extension, the broker-targets storage column on `oauth_connections`, the pure smart-resolver function, and a feature-flag-gated wiring point inside `resolveAdapterConfigForRuntime` — all of it **behavior-neutral when the flag is off**. No broker implementation yet (M2). No sandbox-runtime edits yet (M3). No UI yet (M3). Reviewers can land this entire milestone without changing any agent's runtime behavior.

**Architecture:** All M1 work is contract + plumbing. The smart resolver (`resolveCredentialDelivery`) is a pure function, fully unit-tested in isolation, that is *called* from `resolveAdapterConfigForRuntime` only when `PAPERCLIP_FEATURE_CREDENTIAL_BROKER=1`. With the flag off (default), the legacy plaintext-bearer path from #5805 runs unchanged — verified by a regression-test pass over the existing oauth_token binding suite. The plugin SDK gains `registerCredentialBroker()` but no in-tree broker is registered yet (the `@paperclipai/credential-broker-builtin` package is scaffolded with a placeholder export only).

**Tech Stack:** TypeScript, Zod, Drizzle ORM (PostgreSQL), vitest. Existing Paperclip patterns: shared types in `packages/shared/`, plugin SDK in `packages/plugins/sdk/`, services in `server/src/services/`, schemas in `packages/db/src/schema/`.

**Spec reference:** `docs/superpowers/specs/2026-05-12-credential-broker-design.md` — Decision 1, §1.3 (the resolver), §2 (plugin interface), §6 (integration with #5805), §11 (rollout, steps 1–4).

**Depends on:** PR #5805 (OAuth backbone) merged to master. M1 modifies `AdapterConfig` (introduced by #5805) and the OAuth provider YAML schema (also #5805). Tasks that scaffold the plugin-sdk types and the new builtin package (Tasks 1–2) are technically #5805-independent and *could* land first if scheduling demanded, but the rest of M1 must follow #5805.

---

## File Structure

### New files

```
packages/plugins/sdk/src/
└── credential-broker.ts                                # NEW — types + registerCredentialBroker()

packages/plugins/credential-brokers/                    # NEW directory (parallel to sandbox-providers/)
└── builtin/                                            # @paperclipai/credential-broker-builtin
    ├── package.json
    ├── tsconfig.json
    ├── README.md
    └── src/
        └── index.ts                                    # placeholder export (real broker lands in M2)

packages/db/src/migrations/
└── 0086_broker_targets.sql                             # NEW (idempotent additive JSONB column)

server/src/
├── plugins/
│   ├── credential-broker-registry.ts                   # NEW
│   └── credential-broker-registry.test.ts
├── services/
│   ├── broker-targets.ts                               # NEW (CRUD, no callers in M1)
│   └── broker-targets.test.ts
└── oauth/
    ├── resolve-credential-delivery.ts                  # NEW — the pure smart resolver
    ├── resolve-credential-delivery.test.ts
    └── credential-broker-log.ts                        # NEW — structured fallback warn-log

docs/adapters/
└── credential-broker.md                                # NEW — operator-facing intro
```

### Modified files

| File | What changes |
|---|---|
| `packages/plugins/sdk/src/index.ts` | Re-export `registerCredentialBroker` and its types. |
| `packages/shared/src/agent-config.ts` (or wherever `AdapterConfig` zod schema lives — confirm via `rg "credentialDelivery\|AdapterConfig" packages/shared`) | Add optional `credentialDelivery: z.enum(["env", "paperclip-broker", "byo-broker"]).optional()`. |
| `packages/db/src/schema/oauth.ts` (introduced by #5805) | Add `brokerTargets` column to `oauthConnections` table. |
| `packages/db/src/index.ts` | Re-export updated schema (likely already covered). |
| `server/src/services/secrets.ts` — `resolveAdapterConfigForRuntime` | When `PAPERCLIP_FEATURE_CREDENTIAL_BROKER=1`, call `resolveCredentialDelivery()` and branch. With flag off, current behavior is unchanged. |
| `server/src/config/env.ts` (or wherever env vars are loaded — confirm via `rg "process.env" server/src/config`) | Add `PAPERCLIP_FEATURE_CREDENTIAL_BROKER` (default off) and `PAPERCLIP_REQUIRE_BROKER` (default off, only honored when feature flag on). |
| `server/oauth-providers/*.yaml` (introduced by #5805) | Add `broker:` block per provider — `supported: false` for all providers in M1. M3 flips them to `true` as each is validated. |
| `server/src/oauth/yaml-loader.ts` (introduced by #5805) and its Zod schema | Extend to accept the optional `broker:` block. |
| `pnpm-workspace.yaml` | Verify `packages/plugins/credential-brokers/*` resolves. |

### Provider YAML audit (Risk #11 from the spec)

A dedicated task adds `broker: { supported: false, delivery_modes_supported: [env] }` to every provider YAML #5805 ships. With `supported: false`, the smart resolver returns `env` with `reason: "provider_not_broker_compatible"` — even if a broker is registered. M3 flips them to `true` provider-by-provider after end-to-end smoke tests against the built-in broker.

---

## Dependencies

No new runtime dependencies in M1. The placeholder `@paperclipai/credential-broker-builtin` package depends only on `@paperclipai/plugin-sdk` (workspace).

---

## Sequencing & Workstream Notes

- Tasks 1–2 are foundational (plugin SDK types + placeholder package). Independent of #5805.
- Tasks 3–5 are schema/migration work — sequential.
- Tasks 6–8 are server-side plumbing (registry, env flag, service) — parallelisable after Task 2.
- Task 9 is the pure smart resolver — depends on Task 2 (types only).
- Task 10 wires the resolver into `resolveAdapterConfigForRuntime` — depends on 6, 8, 9.
- Tasks 11–13 are tests and regression guards — depend on 10.
- Task 14 is docs — anytime after Task 9.

---

## Task 1: Add credential-broker types and `registerCredentialBroker()` to plugin SDK

**Files:**
- Create: `packages/plugins/sdk/src/credential-broker.ts`
- Create: `packages/plugins/sdk/src/__tests__/credential-broker.test.ts`
- Modify: `packages/plugins/sdk/src/index.ts`

Reference: spec §2.1.

- [ ] **Step 1: Write failing test for the registration shape**

Create `packages/plugins/sdk/src/__tests__/credential-broker.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  registerCredentialBroker,
  type CredentialBroker,
  type RegisterCredentialBrokerCtx,
} from "../credential-broker.js";
import { __resetRegistryForTests, __getRegisteredBrokerFactoryForTests } from "../credential-broker.js";

describe("registerCredentialBroker", () => {
  beforeEach(() => __resetRegistryForTests());

  it("stores the factory for later resolution", () => {
    const factory = vi.fn();
    registerCredentialBroker(factory);
    expect(__getRegisteredBrokerFactoryForTests()).toBe(factory);
  });

  it("rejects double-registration with a clear error", () => {
    registerCredentialBroker(() => stubBroker());
    expect(() => registerCredentialBroker(() => stubBroker())).toThrow(
      /already registered/i,
    );
  });
});

function stubBroker(): CredentialBroker {
  return {
    id: "stub",
    mintSession: async () => ({ sessionToken: "", proxyUrl: "", caCertPem: "", placeholders: {} }),
    pushCredential: async () => {},
    revokeSession: async () => {},
    isReachableFrom: () => false,
  };
}
```

- [ ] **Step 2: Run test, expect failure**

Run: `pnpm --filter @paperclipai/plugin-sdk test credential-broker -- --run`
Expected: module-not-found.

- [ ] **Step 3: Implement `credential-broker.ts`**

```ts
// packages/plugins/sdk/src/credential-broker.ts

import type { PluginLogger } from "./logger.js";

export type CredentialDeliveryMode = "env" | "paperclip-broker" | "byo-broker";

export interface CredentialBrokerSession {
  /** Opaque one-time-use bearer; agent uses it as Proxy-Authorization. */
  sessionToken: string;
  /** Proxy URL the orchestrator must set as HTTPS_PROXY / HTTP_PROXY. */
  proxyUrl: string;
  /** PEM-encoded CA cert the agent process must trust for MITM TLS. */
  caCertPem: string;
  /** envVarName → deterministic placeholder string (no secret content). */
  placeholders: Record<string, string>;
}

export interface MintSessionInput {
  companyId: string;
  runId: string;
  connectionIds: string[];
  oauthEnvBindings: Array<{
    envVarName: string;
    connectionId: string;
    field: "access";
  }>;
  ttlSeconds?: number;
}

/** Minimal description of an execution target the resolver passes to brokers. */
export interface ExecutionTargetSummary {
  kind: string;                  // "local" | "ssh" | "sandbox" | "kubernetes" | "external" | ...
  sandboxProvider?: string;      // "e2b" | "daytona" | undefined
}

export interface CredentialBroker {
  readonly id: string;
  mintSession(input: MintSessionInput): Promise<CredentialBrokerSession>;
  pushCredential(input: {
    companyId: string;
    connectionId: string;
    field: "access" | "refresh";
    value: string;
    expiresAt?: Date;
  }): Promise<void>;
  revokeSession(sessionToken: string): Promise<void>;
  /**
   * Capability check: can my proxy listener be reached from a process
   * spawned in this execution target? The smart resolver consults this
   * to decide whether to use paperclip-broker mode or fall back.
   */
  isReachableFrom(target: ExecutionTargetSummary): boolean;
}

export interface RegisterCredentialBrokerCtx {
  resolveConnections: (companyId: string) => Promise<Array<{
    id: string;
    providerId: string;
    hosts: string[];
    headerInjection: { header: string; format: string };
  }>>;
  logger: PluginLogger;
}

export type CredentialBrokerFactory = (
  ctx: RegisterCredentialBrokerCtx,
) => CredentialBroker | Promise<CredentialBroker>;

let registered: CredentialBrokerFactory | undefined;

export function registerCredentialBroker(factory: CredentialBrokerFactory): void {
  if (registered) {
    throw new Error(
      "registerCredentialBroker: a credential broker is already registered. " +
      "Only one credential-broker plugin can be active per Paperclip server process.",
    );
  }
  registered = factory;
}

/** @internal — for the server-side registry to consume at startup. */
export function __consumeRegisteredCredentialBrokerFactory(): CredentialBrokerFactory | undefined {
  return registered;
}

/** @internal — test helpers. */
export function __resetRegistryForTests(): void {
  registered = undefined;
}
export function __getRegisteredBrokerFactoryForTests(): CredentialBrokerFactory | undefined {
  return registered;
}
```

- [ ] **Step 4: Re-export from `packages/plugins/sdk/src/index.ts`**

Append:

```ts
export {
  registerCredentialBroker,
  __consumeRegisteredCredentialBrokerFactory,
} from "./credential-broker.js";
export type {
  CredentialDeliveryMode,
  CredentialBroker,
  CredentialBrokerSession,
  MintSessionInput,
  ExecutionTargetSummary,
  RegisterCredentialBrokerCtx,
  CredentialBrokerFactory,
} from "./credential-broker.js";
```

- [ ] **Step 5: Tests pass**

Run: `pnpm --filter @paperclipai/plugin-sdk test credential-broker -- --run`
Expected: 2 tests pass.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @paperclipai/plugin-sdk typecheck`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/sdk/src/credential-broker.ts \
        packages/plugins/sdk/src/__tests__/credential-broker.test.ts \
        packages/plugins/sdk/src/index.ts
git commit -m "feat(plugin-sdk): add registerCredentialBroker() extension slot"
```

---

## Task 2: Scaffold `@paperclipai/credential-broker-builtin` placeholder package

**Files:**
- Create: `packages/plugins/credential-brokers/builtin/package.json`
- Create: `packages/plugins/credential-brokers/builtin/tsconfig.json`
- Create: `packages/plugins/credential-brokers/builtin/src/index.ts`
- Create: `packages/plugins/credential-brokers/builtin/README.md`

Reference: spec §3 (full implementation lands in M2; M1 only scaffolds).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@paperclipai/credential-broker-builtin",
  "version": "0.0.0",
  "license": "MIT",
  "homepage": "https://github.com/paperclipai/paperclip",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "publishConfig": {
    "access": "public",
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js"
      }
    },
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@paperclipai/plugin-sdk": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Match the surrounding plugin packages' tsconfig — extend the closest `tsconfig.base.json` and emit declarations into `dist/`.

- [ ] **Step 3: Placeholder `src/index.ts`**

```ts
// Implementation lands in M2 — see
// docs/superpowers/specs/2026-05-12-credential-broker-design.md §3
export const PACKAGE_NAME = "@paperclipai/credential-broker-builtin";
```

- [ ] **Step 4: Minimal README**

```markdown
# @paperclipai/credential-broker-builtin

Default credential broker plugin for Paperclip. **Implementation lands in M2.**
M1 ships the package scaffold so the workspace resolves cleanly.

See the [design spec](../../../../docs/superpowers/specs/2026-05-12-credential-broker-design.md)
and the M1 implementation plan.
```

- [ ] **Step 5: Verify the workspace picks the package up**

Run: `pnpm install && pnpm --filter @paperclipai/credential-broker-builtin build`
Expected: build succeeds, `dist/index.js` produced.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/credential-brokers/builtin
git commit -m "feat(credential-broker): scaffold @paperclipai/credential-broker-builtin (M2 placeholder)"
```

---

## Task 3: Add optional `credentialDelivery` field to `AdapterConfig`

**Files:**
- Modify: `packages/shared/src/agent-config.ts` (locate via `rg "AdapterConfig" packages/shared/src`)
- Add: `packages/shared/src/__tests__/agent-config-credential-delivery.test.ts`

Reference: spec Decision 1, §6.1.

- [ ] **Step 1: Locate the existing `AdapterConfig` Zod schema**

```bash
rg -n "AdapterConfig\\b" packages/shared/src
```

Confirm the file path before editing — #5805 introduced the binding shape so the exact location may differ.

- [ ] **Step 2: Write failing test**

```ts
// packages/shared/src/__tests__/agent-config-credential-delivery.test.ts
import { describe, it, expect } from "vitest";
import { adapterConfigSchema } from "../agent-config.js";

describe("AdapterConfig — credentialDelivery", () => {
  const base = { /* minimal valid AdapterConfig minus credentialDelivery */ };

  it("accepts when credentialDelivery is unset", () => {
    expect(() => adapterConfigSchema.parse({ ...base })).not.toThrow();
  });

  it.each(["env", "paperclip-broker", "byo-broker"])("accepts %s", (v) => {
    expect(() => adapterConfigSchema.parse({ ...base, credentialDelivery: v })).not.toThrow();
  });

  it("rejects unknown values", () => {
    expect(() => adapterConfigSchema.parse({ ...base, credentialDelivery: "magic" })).toThrow();
  });
});
```

Populate `base` from whatever #5805 produced — check the existing config-shape test in `packages/shared/src/__tests__/`.

- [ ] **Step 3: Run, expect failure (TS or Zod)**

- [ ] **Step 4: Add the field to the Zod schema**

```ts
// inside adapterConfigSchema
credentialDelivery: z.enum(["env", "paperclip-broker", "byo-broker"]).optional(),
```

- [ ] **Step 5: Tests pass**

Run: `pnpm --filter @paperclipai/shared test agent-config -- --run`

- [ ] **Step 6: Typecheck all dependents**

```bash
pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/ui typecheck
pnpm --filter @paperclipai/plugin-sdk typecheck
```

Expected: all pass — the field is optional, no existing code needs updating.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/agent-config.ts \
        packages/shared/src/__tests__/agent-config-credential-delivery.test.ts
git commit -m "feat(shared): reserve optional credentialDelivery field on AdapterConfig"
```

---

## Task 4: Drizzle migration — `oauth_connections.broker_targets`

**Files:**
- Create: `packages/db/src/migrations/0086_broker_targets.sql`
- Modify: `packages/db/src/schema/oauth.ts`
- Modify: `packages/db/src/migrations/meta/_journal.json` (drizzle-kit generates)

Reference: spec §6.1 ("smallest possible schema delta").

- [ ] **Step 1: Write the migration**

```sql
-- packages/db/src/migrations/0086_broker_targets.sql
-- Idempotent additive column for BYO credential-broker push targets.
-- Follows the #5805 idempotency convention.
ALTER TABLE oauth_connections
  ADD COLUMN IF NOT EXISTS broker_targets jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Defensive check constraint: array of objects with required string fields.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'oauth_connections_broker_targets_shape'
  ) THEN
    ALTER TABLE oauth_connections
      ADD CONSTRAINT oauth_connections_broker_targets_shape
      CHECK (jsonb_typeof(broker_targets) = 'array');
  END IF;
END$$;
```

- [ ] **Step 2: Add the column to the Drizzle schema**

```ts
// packages/db/src/schema/oauth.ts — inside oauthConnections pgTable definition
brokerTargets: jsonb("broker_targets")
  .$type<Array<{ url: string; authTokenSecretId: string; addedAt: string }>>()
  .notNull()
  .default(sql`'[]'::jsonb`),
```

Note: `authTokenSecretId` references `company_secrets.id` so the shared secret rotates through the existing pipeline. We do **not** store the auth token in plaintext on the broker target row.

- [ ] **Step 3: Run drizzle-kit and verify journal updated**

```bash
pnpm --filter @paperclipai/db generate
```

Inspect the generated diff for `meta/_journal.json` and any auxiliary files.

- [ ] **Step 4: Add migration test**

In whichever test file currently asserts migration idempotency (`packages/db/src/__tests__/migrations.test.ts` if it exists), add a case that:
1. Applies 0085 (the OAuth migration from #5805), then 0086.
2. Inserts a row into `oauth_connections`.
3. Verifies `broker_targets = '[]'::jsonb`.
4. Updates `broker_targets` to a valid array and a non-array; expects the second to violate the check constraint.

- [ ] **Step 5: Run migration tests**

```bash
pnpm --filter @paperclipai/db test migrations -- --run
```

- [ ] **Step 6: Typecheck dependents**

```bash
pnpm --filter @paperclipai/server typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/migrations/0086_broker_targets.sql \
        packages/db/src/schema/oauth.ts \
        packages/db/src/migrations/meta \
        packages/db/src/__tests__/migrations.test.ts
git commit -m "feat(db): add broker_targets jsonb column on oauth_connections (0086)"
```

---

## Task 5: `broker-targets` service (CRUD; no callers in M1)

**Files:**
- Create: `server/src/services/broker-targets.ts`
- Create: `server/src/services/broker-targets.test.ts`

Reference: spec §5.3 (used by refresh worker push in M2 and by the Settings UI in M3).

- [ ] **Step 1: Failing test (describe-then-implement)**

```ts
// server/src/services/broker-targets.test.ts
import { describe, it, expect } from "vitest";
import { createBrokerTargetsService } from "./broker-targets.js";
import { newTestDb } from "../testing/db.js"; // existing helper from #5805

describe("brokerTargetsService", () => {
  it("lists, adds, and removes targets on a connection", async () => {
    const db = await newTestDb();
    const svc = createBrokerTargetsService({ db });
    const conn = await seedConnection(db);

    expect(await svc.list(conn.id)).toEqual([]);

    const added = await svc.add(conn.id, { url: "https://broker.acme.test/push", authTokenSecretId: "sec-1" });
    expect(added.url).toBe("https://broker.acme.test/push");
    expect((await svc.list(conn.id))[0].addedAt).toBeDefined();

    await svc.remove(conn.id, added.id);
    expect(await svc.list(conn.id)).toEqual([]);
  });

  it("rejects malformed URLs", async () => {
    const db = await newTestDb();
    const svc = createBrokerTargetsService({ db });
    const conn = await seedConnection(db);
    await expect(svc.add(conn.id, { url: "not-a-url", authTokenSecretId: "sec-1" })).rejects.toThrow(/url/i);
  });

  it("enforces a hard cap of 8 targets per connection", async () => {
    const db = await newTestDb();
    const svc = createBrokerTargetsService({ db });
    const conn = await seedConnection(db);
    for (let i = 0; i < 8; i++) {
      await svc.add(conn.id, { url: `https://b${i}.test/push`, authTokenSecretId: "sec-1" });
    }
    await expect(
      svc.add(conn.id, { url: "https://b9.test/push", authTokenSecretId: "sec-1" }),
    ).rejects.toThrow(/too many/i);
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement the service**

```ts
// server/src/services/broker-targets.ts
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { oauthConnections } from "@paperclipai/db/schema/oauth";
import type { Database } from "../db.js";

const URL_SCHEMA = z.string().url().refine((u) => u.startsWith("https://") || u.startsWith("http://"));
const MAX_TARGETS_PER_CONNECTION = 8;

export interface BrokerTarget {
  id: string;
  url: string;
  authTokenSecretId: string;
  addedAt: string;
}

export interface BrokerTargetsServiceDeps { db: Database; }

export function createBrokerTargetsService(deps: BrokerTargetsServiceDeps) {
  return {
    list: async (connectionId: string): Promise<BrokerTarget[]> => {
      const [row] = await deps.db
        .select({ brokerTargets: oauthConnections.brokerTargets })
        .from(oauthConnections)
        .where(eq(oauthConnections.id, connectionId));
      return (row?.brokerTargets ?? []) as BrokerTarget[];
    },

    add: async (
      connectionId: string,
      input: { url: string; authTokenSecretId: string },
    ): Promise<BrokerTarget> => {
      URL_SCHEMA.parse(input.url);
      const target: BrokerTarget = {
        id: ulid(),
        url: input.url,
        authTokenSecretId: input.authTokenSecretId,
        addedAt: new Date().toISOString(),
      };
      return deps.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ brokerTargets: oauthConnections.brokerTargets })
          .from(oauthConnections)
          .where(eq(oauthConnections.id, connectionId))
          .for("update");
        const current = (row?.brokerTargets ?? []) as BrokerTarget[];
        if (current.length >= MAX_TARGETS_PER_CONNECTION) {
          throw new Error("too many broker targets for connection");
        }
        await tx
          .update(oauthConnections)
          .set({ brokerTargets: [...current, target] })
          .where(eq(oauthConnections.id, connectionId));
        return target;
      });
    },

    remove: async (connectionId: string, targetId: string): Promise<void> => {
      await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ brokerTargets: oauthConnections.brokerTargets })
          .from(oauthConnections)
          .where(eq(oauthConnections.id, connectionId))
          .for("update");
        const current = (row?.brokerTargets ?? []) as BrokerTarget[];
        await tx
          .update(oauthConnections)
          .set({ brokerTargets: current.filter((t) => t.id !== targetId) })
          .where(eq(oauthConnections.id, connectionId));
      });
    },
  };
}
```

- [ ] **Step 4: Tests pass**

```bash
pnpm --filter @paperclipai/server test broker-targets -- --run
```

- [ ] **Step 5: Commit**

```bash
git add server/src/services/broker-targets.ts \
        server/src/services/broker-targets.test.ts
git commit -m "feat(server): add broker-targets service (CRUD, no callers in M1)"
```

---

## Task 6: Server-side credential-broker registry

**Files:**
- Create: `server/src/plugins/credential-broker-registry.ts`
- Create: `server/src/plugins/credential-broker-registry.test.ts`

Reference: spec §2.3 (plugin loader picks at most one broker).

- [ ] **Step 1: Failing test**

```ts
// server/src/plugins/credential-broker-registry.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { __resetRegistryForTests, registerCredentialBroker } from "@paperclipai/plugin-sdk";
import { resolveCredentialBroker } from "./credential-broker-registry.js";

const ctx = { resolveConnections: async () => [], logger: console } as any;

describe("resolveCredentialBroker", () => {
  beforeEach(() => __resetRegistryForTests());

  it("returns undefined when no broker is registered", async () => {
    expect(await resolveCredentialBroker(ctx)).toBeUndefined();
  });

  it("returns the registered broker exactly once", async () => {
    registerCredentialBroker(() => ({
      id: "test",
      mintSession: async () => ({ sessionToken: "x", proxyUrl: "y", caCertPem: "z", placeholders: {} }),
      pushCredential: async () => {},
      revokeSession: async () => {},
      isReachableFrom: () => true,
    }));
    const b = await resolveCredentialBroker(ctx);
    expect(b?.id).toBe("test");
  });

  it("caches the resolved broker across calls", async () => {
    let count = 0;
    registerCredentialBroker(() => {
      count++;
      return {
        id: "test", mintSession: async () => null as any, pushCredential: async () => {},
        revokeSession: async () => {}, isReachableFrom: () => false,
      };
    });
    await resolveCredentialBroker(ctx);
    await resolveCredentialBroker(ctx);
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

```ts
// server/src/plugins/credential-broker-registry.ts
import {
  __consumeRegisteredCredentialBrokerFactory,
  type CredentialBroker,
  type RegisterCredentialBrokerCtx,
} from "@paperclipai/plugin-sdk";

let cached: CredentialBroker | undefined;
let resolved = false;

export async function resolveCredentialBroker(
  ctx: RegisterCredentialBrokerCtx,
): Promise<CredentialBroker | undefined> {
  if (resolved) return cached;
  const factory = __consumeRegisteredCredentialBrokerFactory();
  if (!factory) {
    resolved = true;
    return undefined;
  }
  cached = await factory(ctx);
  resolved = true;
  return cached;
}

/** Test-only — re-resolve next time. */
export function __resetResolvedBrokerForTests(): void {
  cached = undefined;
  resolved = false;
}
```

- [ ] **Step 4: Tests pass**

```bash
pnpm --filter @paperclipai/server test credential-broker-registry -- --run
```

- [ ] **Step 5: Commit**

```bash
git add server/src/plugins/credential-broker-registry.ts \
        server/src/plugins/credential-broker-registry.test.ts
git commit -m "feat(server): credential-broker plugin registry (single-broker resolution)"
```

---

## Task 7: Feature-flag env vars

**Files:**
- Modify: `server/src/config/env.ts` (locate via `rg "process.env.PAPERCLIP" server/src/config server/src/index.ts`)
- Add: `server/src/config/env.test.ts` (extend if it exists)

- [ ] **Step 1: Add the two flags to the env schema**

```ts
// inside the existing Zod env schema
PAPERCLIP_FEATURE_CREDENTIAL_BROKER: z
  .enum(["0", "1"])
  .default("0")
  .transform((v) => v === "1"),
PAPERCLIP_REQUIRE_BROKER: z
  .enum(["0", "1"])
  .default("0")
  .transform((v) => v === "1"),
```

- [ ] **Step 2: Test that both default to false**

- [ ] **Step 3: Commit**

```bash
git add server/src/config/env.ts server/src/config/env.test.ts
git commit -m "feat(server): add PAPERCLIP_FEATURE_CREDENTIAL_BROKER and PAPERCLIP_REQUIRE_BROKER flags (default off)"
```

---

## Task 8: Pure smart-resolver function

**Files:**
- Create: `server/src/oauth/resolve-credential-delivery.ts`
- Create: `server/src/oauth/resolve-credential-delivery.test.ts`

Reference: spec §1.3 — this is **the** behavior-defining function for M1. Keep it pure: no IO, no logging, no clock. Unit-test every branch.

- [ ] **Step 1: Failing tests — cover every branch**

```ts
// server/src/oauth/resolve-credential-delivery.test.ts
import { describe, it, expect } from "vitest";
import { resolveCredentialDelivery } from "./resolve-credential-delivery.js";
import type { CredentialBroker, ExecutionTargetSummary } from "@paperclipai/plugin-sdk";

const stubBroker = (reachable: boolean): CredentialBroker => ({
  id: "stub",
  mintSession: async () => ({} as any),
  pushCredential: async () => {},
  revokeSession: async () => {},
  isReachableFrom: () => reachable,
});

const local: ExecutionTargetSummary = { kind: "local" };
const external: ExecutionTargetSummary = { kind: "external" };
const e2b: ExecutionTargetSummary = { kind: "sandbox", sandboxProvider: "e2b" };

describe("resolveCredentialDelivery", () => {
  it("honors explicit config when set", () => {
    const r = resolveCredentialDelivery({
      explicit: "env",
      executionTarget: local,
      oauthBindings: [],
      registeredBroker: stubBroker(true),
      hasBrokerTargetsFor: () => true,
      providerBrokerSupported: () => true,
    });
    expect(r).toEqual({ mode: "env", reason: "explicit_config" });
  });

  it("external runtime + all bindings have targets → byo-broker", () => {
    const r = resolveCredentialDelivery({
      explicit: undefined,
      executionTarget: external,
      oauthBindings: [{ envVarName: "GH", connectionId: "c-1", field: "access" }],
      registeredBroker: undefined,
      hasBrokerTargetsFor: () => true,
      providerBrokerSupported: () => true,
    });
    expect(r).toEqual({ mode: "byo-broker", reason: "external_runtime_with_byo_targets" });
  });

  it("external runtime + missing targets → env", () => {
    const r = resolveCredentialDelivery({
      explicit: undefined,
      executionTarget: external,
      oauthBindings: [{ envVarName: "GH", connectionId: "c-1", field: "access" }],
      registeredBroker: undefined,
      hasBrokerTargetsFor: () => false,
      providerBrokerSupported: () => true,
    });
    expect(r.mode).toBe("env");
    expect(r.reason).toBe("external_runtime_no_broker_targets");
  });

  it("internal runtime, reachable broker, provider supported → paperclip-broker", () => {
    const r = resolveCredentialDelivery({
      explicit: undefined,
      executionTarget: local,
      oauthBindings: [{ envVarName: "GH", connectionId: "c-1", field: "access" }],
      registeredBroker: stubBroker(true),
      hasBrokerTargetsFor: () => false,
      providerBrokerSupported: () => true,
    });
    expect(r.mode).toBe("paperclip-broker");
    expect(r.reason).toBe("broker_available_and_reachable");
  });

  it("internal runtime, broker exists but unreachable from runtime → env", () => {
    const r = resolveCredentialDelivery({
      explicit: undefined,
      executionTarget: e2b,
      oauthBindings: [{ envVarName: "GH", connectionId: "c-1", field: "access" }],
      registeredBroker: stubBroker(false),
      hasBrokerTargetsFor: () => false,
      providerBrokerSupported: () => true,
    });
    expect(r.mode).toBe("env");
    expect(r.reason).toBe("broker_unreachable_from_runtime");
  });

  it("internal runtime, no broker registered → env", () => {
    const r = resolveCredentialDelivery({
      explicit: undefined,
      executionTarget: local,
      oauthBindings: [{ envVarName: "GH", connectionId: "c-1", field: "access" }],
      registeredBroker: undefined,
      hasBrokerTargetsFor: () => false,
      providerBrokerSupported: () => true,
    });
    expect(r.mode).toBe("env");
    expect(r.reason).toBe("no_broker_registered");
  });

  it("any binding's provider not broker-compatible → env", () => {
    const r = resolveCredentialDelivery({
      explicit: undefined,
      executionTarget: local,
      oauthBindings: [
        { envVarName: "GH", connectionId: "c-1", field: "access" },
        { envVarName: "SL", connectionId: "c-2", field: "access" },
      ],
      registeredBroker: stubBroker(true),
      hasBrokerTargetsFor: () => false,
      providerBrokerSupported: (cid) => cid !== "c-2",
    });
    expect(r.mode).toBe("env");
    expect(r.reason).toBe("provider_not_broker_compatible");
  });

  it("no oauth bindings at all → env (resolver is a no-op signal)", () => {
    const r = resolveCredentialDelivery({
      explicit: undefined,
      executionTarget: local,
      oauthBindings: [],
      registeredBroker: stubBroker(true),
      hasBrokerTargetsFor: () => false,
      providerBrokerSupported: () => true,
    });
    expect(r.mode).toBe("env");
    expect(r.reason).toBe("no_oauth_bindings");
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement the pure function**

```ts
// server/src/oauth/resolve-credential-delivery.ts
import type {
  CredentialBroker,
  CredentialDeliveryMode,
  ExecutionTargetSummary,
} from "@paperclipai/plugin-sdk";

export interface OAuthBindingSummary {
  envVarName: string;
  connectionId: string;
  field: "access";
}

export type DeliveryReason =
  | "explicit_config"
  | "no_oauth_bindings"
  | "external_runtime_with_byo_targets"
  | "external_runtime_no_broker_targets"
  | "broker_available_and_reachable"
  | "broker_unreachable_from_runtime"
  | "no_broker_registered"
  | "provider_not_broker_compatible";

export interface ResolveCredentialDeliveryInput {
  /** When the agent config explicitly sets the mode, honor it. */
  explicit: CredentialDeliveryMode | undefined;
  executionTarget: ExecutionTargetSummary;
  oauthBindings: OAuthBindingSummary[];
  registeredBroker: CredentialBroker | undefined;
  hasBrokerTargetsFor: (connectionId: string) => boolean;
  providerBrokerSupported: (connectionId: string) => boolean;
}

export interface ResolveCredentialDeliveryResult {
  mode: CredentialDeliveryMode;
  reason: DeliveryReason;
}

const EXTERNAL_RUNTIME_KINDS = new Set(["external", "webhook"]);

export function resolveCredentialDelivery(
  input: ResolveCredentialDeliveryInput,
): ResolveCredentialDeliveryResult {
  if (input.explicit) {
    return { mode: input.explicit, reason: "explicit_config" };
  }

  if (input.oauthBindings.length === 0) {
    return { mode: "env", reason: "no_oauth_bindings" };
  }

  const allProvidersSupportBroker = input.oauthBindings.every((b) =>
    input.providerBrokerSupported(b.connectionId),
  );
  if (!allProvidersSupportBroker) {
    return { mode: "env", reason: "provider_not_broker_compatible" };
  }

  if (EXTERNAL_RUNTIME_KINDS.has(input.executionTarget.kind)) {
    const allHaveTargets = input.oauthBindings.every((b) =>
      input.hasBrokerTargetsFor(b.connectionId),
    );
    return allHaveTargets
      ? { mode: "byo-broker", reason: "external_runtime_with_byo_targets" }
      : { mode: "env", reason: "external_runtime_no_broker_targets" };
  }

  if (!input.registeredBroker) {
    return { mode: "env", reason: "no_broker_registered" };
  }

  if (!input.registeredBroker.isReachableFrom(input.executionTarget)) {
    return { mode: "env", reason: "broker_unreachable_from_runtime" };
  }

  return { mode: "paperclip-broker", reason: "broker_available_and_reachable" };
}
```

- [ ] **Step 4: Tests pass**

```bash
pnpm --filter @paperclipai/server test resolve-credential-delivery -- --run
```

Expected: 8/8 pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/resolve-credential-delivery.ts \
        server/src/oauth/resolve-credential-delivery.test.ts
git commit -m "feat(oauth): pure smart-resolver for credential delivery mode"
```

---

## Task 9: Structured fallback warn-log

**Files:**
- Create: `server/src/oauth/credential-broker-log.ts`
- Create: `server/src/oauth/credential-broker-log.test.ts`

Reference: spec §1.3 — every fallback to `env` emits exactly this log.

- [ ] **Step 1: Failing test**

```ts
// server/src/oauth/credential-broker-log.test.ts
import { describe, it, expect, vi } from "vitest";
import { logCredentialBrokerFallbackToEnv } from "./credential-broker-log.js";

describe("logCredentialBrokerFallbackToEnv", () => {
  it("emits a structured warn with the right shape", () => {
    const warn = vi.fn();
    const logger = { warn } as any;
    logCredentialBrokerFallbackToEnv(logger, {
      runId: "run-1",
      agentId: "a-1",
      executionTargetKind: "sandbox",
      sandboxProvider: "e2b",
      reason: "broker_unreachable_from_runtime",
      bindings: [{ envVarName: "GH", connectionId: "c-1" }],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [arg] = warn.mock.calls[0];
    expect(arg.event).toBe("credential-broker-fallback-to-env");
    expect(arg.reason).toBe("broker_unreachable_from_runtime");
    expect(arg.hint).toContain("standalone");
  });

  it("hint references PAPERCLIP_REQUIRE_BROKER when explicit override is desired", () => {
    const warn = vi.fn();
    logCredentialBrokerFallbackToEnv({ warn } as any, {
      runId: "r", agentId: "a", executionTargetKind: "external", reason: "external_runtime_no_broker_targets", bindings: [],
    });
    const [arg] = warn.mock.calls[0];
    expect(arg.hint).toContain("byo-broker");
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

```ts
// server/src/oauth/credential-broker-log.ts
import type { Logger } from "pino";
import type { DeliveryReason } from "./resolve-credential-delivery.js";

interface FallbackLogInput {
  runId: string;
  agentId: string;
  executionTargetKind: string;
  sandboxProvider?: string;
  reason: DeliveryReason;
  bindings: Array<{ envVarName: string; connectionId: string }>;
}

const HINTS: Record<DeliveryReason, string> = {
  explicit_config: "Agent config explicitly opts in to env delivery — no action needed.",
  no_oauth_bindings: "No oauth_token bindings on this dispatch.",
  external_runtime_with_byo_targets: "Should not reach this log — using byo-broker.",
  external_runtime_no_broker_targets:
    "Externally-hired runtime with no registered broker targets. Register a broker push target on each oauth connection to switch to byo-broker, " +
    "or set credentialDelivery: env on the agent config to silence this warning.",
  broker_available_and_reachable: "Should not reach this log — using paperclip-broker.",
  broker_unreachable_from_runtime:
    "The registered credential broker is not reachable from this runtime. Install/enable the broker in standalone mode reachable from this sandbox, " +
    "or set credentialDelivery: env on the agent config to silence this warning.",
  no_broker_registered:
    "No credential broker plugin is registered. Install @paperclipai/credential-broker-builtin or another registerCredentialBroker() plugin, " +
    "or set credentialDelivery: env on the agent config to silence this warning.",
  provider_not_broker_compatible:
    "One or more bindings reference an OAuth provider whose YAML has broker.supported: false. " +
    "Either await the provider's M3 rollout or set credentialDelivery: env on the agent config.",
};

export function logCredentialBrokerFallbackToEnv(logger: Logger, input: FallbackLogInput): void {
  logger.warn({
    event: "credential-broker-fallback-to-env",
    runId: input.runId,
    agentId: input.agentId,
    executionTarget: { kind: input.executionTargetKind, sandboxProvider: input.sandboxProvider },
    reason: input.reason,
    bindings: input.bindings,
    hint: HINTS[input.reason],
  });
}
```

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/credential-broker-log.ts \
        server/src/oauth/credential-broker-log.test.ts
git commit -m "feat(oauth): structured credential-broker-fallback-to-env warn-log"
```

---

## Task 10: Wire the resolver into `resolveAdapterConfigForRuntime` behind the flag

**Files:**
- Modify: `server/src/services/secrets.ts` (where `resolveAdapterConfigForRuntime` lives — from #5805)
- Add: `server/src/services/secrets-credential-delivery.test.ts`

Reference: spec §6.1 — *the* integration seam.

**Behavior contract:**
1. Flag off (default) → legacy path unchanged. Existing #5805 tests for `oauth_token` bindings must pass without modification.
2. Flag on, resolver returns `env` → identical to legacy path, plus the warn-log.
3. Flag on, resolver returns `paperclip-broker` → in M1 this still returns `env`-style plaintext *because no broker is registered in M1*. The path is reachable and tested, but functionally degrades to env. M2 makes it actually use the broker.
4. Flag on, resolver returns `byo-broker` → in M1 still returns env (no caller for the placeholder path yet). Behavior-neutral.
5. Flag on **and** `PAPERCLIP_REQUIRE_BROKER=1` and resolver would fall back to env → throw `CredentialBrokerRequiredError`.

This ordering means **M1 lands with the smart-resolver wired but provably behavior-neutral**: until a broker is registered (M2) and provider YAML flips `broker.supported: true` (M3), the dispatch path returns the same plaintext bearers it does today.

- [ ] **Step 1: Failing test — flag-off regression**

```ts
// server/src/services/secrets-credential-delivery.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetRegistryForTests, registerCredentialBroker } from "@paperclipai/plugin-sdk";
import { __resetResolvedBrokerForTests } from "../plugins/credential-broker-registry.js";

describe("resolveAdapterConfigForRuntime — flag off (default)", () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __resetResolvedBrokerForTests();
    process.env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER = "0";
  });

  it("returns plaintext bearer for oauth_token binding (existing #5805 behavior)", async () => {
    // Reuse the test scaffolding from #5805's resolveAdapterConfigForRuntime test.
    const svc = await newSecretsServiceWithOAuthFixture();
    const r = await svc.resolveAdapterConfigForRuntime("co-1", {
      env: { GH: { type: "oauth_token", connectionId: "c-1", field: "access" } },
    });
    expect(r.env.GH).toMatch(/^[A-Za-z0-9_.-]+$/); // a bearer, not a placeholder
    expect(r.env.HTTPS_PROXY).toBeUndefined();
  });
});

describe("resolveAdapterConfigForRuntime — flag on, no broker registered", () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __resetResolvedBrokerForTests();
    process.env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER = "1";
  });

  it("falls back to env and emits warn-log", async () => {
    const warn = vi.fn();
    const svc = await newSecretsServiceWithOAuthFixture({ logger: { warn } as any });
    const r = await svc.resolveAdapterConfigForRuntime("co-1", {
      env: { GH: { type: "oauth_token", connectionId: "c-1", field: "access" } },
    });
    expect(r.env.GH).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "credential-broker-fallback-to-env",
      reason: "no_broker_registered",
    }));
  });

  it("with PAPERCLIP_REQUIRE_BROKER=1 throws instead of falling back", async () => {
    process.env.PAPERCLIP_REQUIRE_BROKER = "1";
    const svc = await newSecretsServiceWithOAuthFixture();
    await expect(svc.resolveAdapterConfigForRuntime("co-1", {
      env: { GH: { type: "oauth_token", connectionId: "c-1", field: "access" } },
    })).rejects.toThrow(/credential broker required/i);
    process.env.PAPERCLIP_REQUIRE_BROKER = "0";
  });
});
```

`newSecretsServiceWithOAuthFixture` is a test helper — reuse or extend the one #5805 ships in `server/src/services/__tests__/`. If it doesn't exist with that exact name, locate the equivalent fixture builder with `rg "resolveAdapterConfigForRuntime" server/src --files-with-matches`.

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Modify `resolveAdapterConfigForRuntime`**

Sketch of the change (adapt to the existing function's exact shape):

```ts
// server/src/services/secrets.ts — pseudocode of the change
import { env } from "../config/env.js";
import { resolveCredentialBroker } from "../plugins/credential-broker-registry.js";
import { resolveCredentialDelivery } from "../oauth/resolve-credential-delivery.js";
import { logCredentialBrokerFallbackToEnv } from "../oauth/credential-broker-log.js";

export class CredentialBrokerRequiredError extends Error {
  constructor(reason: string) {
    super(`credential broker required but unavailable: ${reason}`);
    this.name = "CredentialBrokerRequiredError";
  }
}

// inside resolveAdapterConfigForRuntime, after collecting oauthBindings:
const oauthBindings = collectOAuthBindings(input);

if (!env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER) {
  // Legacy #5805 path — unchanged.
  return resolveLegacyOAuthBindings(oauthBindings, ctx);
}

const broker = await resolveCredentialBroker(brokerCtx);
const decision = resolveCredentialDelivery({
  explicit: ctx.agentConfig.credentialDelivery,
  executionTarget: summariseExecutionTarget(ctx.executionTarget),
  oauthBindings: oauthBindings.map((b) => ({
    envVarName: b.envVarName, connectionId: b.connectionId, field: "access",
  })),
  registeredBroker: broker,
  hasBrokerTargetsFor: (cid) => ctx.connectionsById.get(cid)?.brokerTargets.length > 0,
  providerBrokerSupported: (cid) => providerOf(cid)?.broker?.supported === true,
});

if (decision.mode === "env") {
  logCredentialBrokerFallbackToEnv(ctx.logger, {
    runId: ctx.runId, agentId: ctx.agentId,
    executionTargetKind: ctx.executionTarget.kind,
    reason: decision.reason,
    bindings: oauthBindings.map((b) => ({ envVarName: b.envVarName, connectionId: b.connectionId })),
  });
  if (env.PAPERCLIP_REQUIRE_BROKER) {
    throw new CredentialBrokerRequiredError(decision.reason);
  }
  return resolveLegacyOAuthBindings(oauthBindings, ctx);
}

// M1: paperclip-broker and byo-broker decisions are reachable but degrade
// to the legacy path because no broker is registered yet (M2 implements).
// We log a debug event so flag-on test environments can observe the decision.
ctx.logger.debug({
  event: "credential-broker-decision-degraded-to-env",
  reason: decision.reason,
  decided_mode: decision.mode,
});
return resolveLegacyOAuthBindings(oauthBindings, ctx);
```

The key invariant: **with no broker registered (M1's reality), the function returns the same value it did in #5805 regardless of the flag setting.** The decision tree is just being exercised and logged.

- [ ] **Step 4: All existing #5805 oauth_token tests still pass**

```bash
pnpm --filter @paperclipai/server test secrets -- --run
pnpm --filter @paperclipai/server test oauth -- --run
```

Expected: every test from #5805's suite passes unchanged.

- [ ] **Step 5: New M1 tests pass**

```bash
pnpm --filter @paperclipai/server test secrets-credential-delivery -- --run
```

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck
```

- [ ] **Step 7: Commit**

```bash
git add server/src/services/secrets.ts \
        server/src/services/secrets-credential-delivery.test.ts
git commit -m "feat(server): wire credential-delivery resolver into resolveAdapterConfigForRuntime (behind flag)"
```

---

## Task 11: Provider YAML — extend schema, mark all `broker.supported: false`

**Files:**
- Modify: `server/src/oauth/yaml-loader.ts` (Zod schema for provider YAML — from #5805)
- Modify: every `server/oauth-providers/*.yaml` shipped by #5805
- Add: `server/src/oauth/__tests__/broker-supported-flag.test.ts`

Reference: spec §11 step 6.

- [ ] **Step 1: Extend the provider YAML Zod schema**

```ts
// inside the existing provider config schema
broker: z.object({
  supported: z.boolean().default(false),
  delivery_modes_supported: z.array(z.enum(["env", "paperclip-broker", "byo-broker"])).default(["env"]),
}).default({ supported: false, delivery_modes_supported: ["env"] }),
```

- [ ] **Step 2: Add `broker:` block to each provider YAML**

```yaml
# server/oauth-providers/github.yaml
broker:
  supported: false
  delivery_modes_supported: [env]
```

Repeat for `notion.yaml`, `slack.yaml`, `linear.yaml`, `atlassian.yaml`, `google.yaml`, `microsoft.yaml`.

- [ ] **Step 3: Test that all #5805-shipped providers parse and default to `supported: false`**

```ts
// server/src/oauth/__tests__/broker-supported-flag.test.ts
import { describe, it, expect } from "vitest";
import { loadAllProviders } from "../yaml-loader.js";

describe("provider YAML — broker block", () => {
  it("every shipped provider parses and defaults to broker.supported = false in M1", async () => {
    const providers = await loadAllProviders();
    expect(providers.length).toBeGreaterThan(0);
    for (const p of providers) {
      expect(p.broker.supported).toBe(false);
      expect(p.broker.delivery_modes_supported).toEqual(["env"]);
    }
  });
});
```

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth/yaml-loader.ts \
        server/oauth-providers \
        server/src/oauth/__tests__/broker-supported-flag.test.ts
git commit -m "feat(oauth): add broker.supported flag to provider YAML schema (default false in M1)"
```

---

## Task 12: Regression sweep — flag off must be a no-op

**Files:**
- Add: `server/src/services/__tests__/secrets-credential-delivery-regression.test.ts`

The most important test in M1. Replays every existing #5805 oauth_token test with the feature flag explicitly off and on, asserting equivalent outputs.

- [ ] **Step 1: Write the parametrised regression**

```ts
// server/src/services/__tests__/secrets-credential-delivery-regression.test.ts
import { describe, it, expect } from "vitest";
import { __resetRegistryForTests } from "@paperclipai/plugin-sdk";
import { __resetResolvedBrokerForTests } from "../../plugins/credential-broker-registry.js";

const SCENARIOS = [
  // Mirror the scenario list #5805 ships in its resolveAdapterConfigForRuntime tests.
  { name: "active oauth_token resolves to plaintext", build: buildActiveBinding },
  { name: "missing connection raises", build: buildMissingConnection },
  { name: "expired token triggers lazy refresh", build: buildExpired },
  { name: "revoked connection raises", build: buildRevoked },
  // ...
];

describe.each([
  { flag: "0", label: "flag off (legacy)" },
  { flag: "1", label: "flag on, no broker (degraded smart-resolver)" },
])("resolveAdapterConfigForRuntime regression — $label", ({ flag }) => {
  it.each(SCENARIOS)("$name", async ({ build }) => {
    __resetRegistryForTests();
    __resetResolvedBrokerForTests();
    process.env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER = flag;
    const { svc, input, expected } = await build();
    if (expected.throws) {
      await expect(svc.resolveAdapterConfigForRuntime(...input)).rejects.toThrow(expected.throws);
    } else {
      const r = await svc.resolveAdapterConfigForRuntime(...input);
      expect(r).toEqual(expected.value);
    }
  });
});
```

The scenario builders (`buildActiveBinding`, etc.) should be extracted from #5805's existing tests, not redefined here. Touching #5805's test file is fine — it's a low-risk pure refactor.

- [ ] **Step 2: Run the regression**

```bash
pnpm --filter @paperclipai/server test secrets-credential-delivery-regression -- --run
```

Expected: every scenario passes under both flag settings.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/__tests__/secrets-credential-delivery-regression.test.ts
git commit -m "test(server): regression — flag off vs flag-on-no-broker must be equivalent"
```

---

## Task 13: Operator docs — credential-broker.md

**Files:**
- Create: `docs/adapters/credential-broker.md`
- Modify: `docs/docs.json` (add the new page to nav — locate via `rg "credential\|adapter" docs/docs.json` for the right group)

Reference: spec §1 (intro), §6 (#5805 integration), §11 (rollout).

- [ ] **Step 1: Write the operator-facing intro**

Single page covering:
1. **What it is**: One paragraph — broker keeps OAuth bearers out of agent address space.
2. **Current status (M1)**: Plumbing only; no behavior change. Flag default off.
3. **The three modes**: brief, with the table from the spec.
4. **The smart-resolver default**: short, with the warn-log shape.
5. **How to enable in M1+** (preview only): set `PAPERCLIP_FEATURE_CREDENTIAL_BROKER=1`. Until M2 ships, this is a no-op other than the decision log.
6. **Roadmap pointer** to M2 and M3 plan docs (will be added later).

Keep under 200 lines. The full design lives in the spec.

- [ ] **Step 2: Add to docs nav**

- [ ] **Step 3: Commit**

```bash
git add docs/adapters/credential-broker.md docs/docs.json
git commit -m "docs(adapters): add credential-broker operator intro (M1)"
```

---

## Task 14: M1 verification checklist

A single PR (or M1 branch) running through this list before requesting review.

- [ ] `pnpm install --frozen-lockfile` — passes (no lockfile churn per the project's lockfile policy)
- [ ] `pnpm -r build` — passes
- [ ] `pnpm -r typecheck` — passes for `@paperclipai/shared`, `@paperclipai/plugin-sdk`, `@paperclipai/server`, `@paperclipai/ui`, `@paperclipai/db`, `@paperclipai/credential-broker-builtin`
- [ ] `pnpm -r test -- --run` — all green
- [ ] Migration applies cleanly on a fresh DB and a DB at the #5805 baseline (`0085`)
- [ ] `PAPERCLIP_FEATURE_CREDENTIAL_BROKER=0` (default): every existing #5805 oauth_token test passes unchanged
- [ ] `PAPERCLIP_FEATURE_CREDENTIAL_BROKER=1`: regression suite still passes (decision logged, value unchanged)
- [ ] `PAPERCLIP_REQUIRE_BROKER=1` + flag on: dispatch with oauth_token bindings throws `CredentialBrokerRequiredError`
- [ ] No new entries in `pnpm-lock.yaml` (per [Paperclip lockfile policy])
- [ ] PR description includes screenshots only if UI changes — M1 has none
- [ ] PR description credits the spec doc and links the milestone

---

## Out of Scope for M1 (covered by later milestones)

- **M2** — `@paperclipai/credential-broker-builtin` full implementation:
  - Per-task ephemeral CA, loopback HTTP CONNECT listener, header injection
  - `mintSession()`, `pushCredential()`, `revokeSession()`, `isReachableFrom()`
  - Wiring into local-subprocess sandbox runtime
  - End-to-end smoke against GitHub provider
  - Flipping `broker.supported: true` on `github.yaml`
- **M3** — Fan-out and operator surface:
  - e2b, daytona, kubernetes sandbox-provider edits (`runtimeFiles` + `extraEnv` plumbing)
  - Standalone broker mode + Helm chart
  - BYO push targets — refresh-worker push, REST routes, Settings UI
  - EnvVarEditor "resolved mode" preview
  - Provider rollout: Slack, Linear, Notion, Atlassian, Google Workspace, Microsoft Graph
  - `broker_fallback_runs_total` metric + alerting docs
  - Upstream coordination with `hermes-paperclip-adapter` and the OpenClaw gateway for the BYO recipe
  - Default-on flip of `PAPERCLIP_FEATURE_CREDENTIAL_BROKER`

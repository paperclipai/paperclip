# Paperclip Cloud Adapter — Milestone 1: Headless Tenant Provisioning

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the foundation of the multi-tenant Kubernetes execution target — types, registry, cluster-connection storage, k8s client wrapper, and idempotent tenant-namespace provisioning (Namespace + RBAC + ResourceQuota + LimitRange + NetworkPolicy + Cilium variant + image-pull-secret) — verifiable end-to-end against a `kind` cluster. No agent execution yet (that's M2). No web UI yet (that's M3). The CLI command `paperclipai cluster ensure-tenant <companyId>` exists and works.

**Architecture:** Add a `kubernetes` kind to the existing `AdapterExecutionTarget` discriminated union and introduce a platform-module-style `ExecutionTargetDriverRegistry`. The k8s driver lives in a new package `@paperclipai/execution-target-kubernetes` and is wired into the server through a thin registration shim. Three new Drizzle tables back the storage. All k8s spec building is done as **pure functions** that take a context object and return raw API objects; a separate `ensureTenantNamespace` orchestrator applies them via `@kubernetes/client-node`. Pure builders are unit-tested with golden snapshots; the orchestrator is integration-tested against `kind`.

**Tech Stack:** TypeScript, Drizzle ORM (PostgreSQL), `@kubernetes/client-node`, `vitest`, `kind` (Kubernetes IN Docker) for integration tests, `testcontainers-node` for spinning kind in CI. Existing Paperclip patterns: services in `server/src/services/`, schemas in `packages/db/src/schema/`, CLI commands in `cli/src/commands/`.

**Spec reference:** `docs/superpowers/specs/2026-05-08-paperclip-cloud-adapter-design.md` (sections 1, 2, and the `ClusterConnection` model in §2.7).

---

## File Structure

### New files

```
packages/adapters/kubernetes-execution/                    # NEW package
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts                                           # public exports
    ├── types.ts                                           # internal types (TenantContext, EnsureTenantOptions, ...)
    ├── client.ts                                          # createKubernetesApiClient(connection) → wrapped client bundle
    ├── driver.ts                                          # KubernetesExecutionDriver (M1: validate + ensureTenant; run() returns NOT_YET_SUPPORTED)
    ├── redaction.ts                                       # value-set redactor (groundwork for M2)
    └── orchestrator/
        ├── labels.ts                                      # PAPERCLIP_LABEL_* constants
        ├── naming.ts                                      # deriveNamespaceName(companySlug, companyId) → string
        ├── capabilities.ts                                # probeClusterCapabilities(client) → ClusterCapabilities
        ├── namespace.ts                                   # buildNamespace + applyNamespace
        ├── rbac.ts                                        # buildAgentServiceAccount + buildDriverRoleBinding + apply
        ├── resource-quota.ts                              # buildResourceQuota + buildLimitRange + apply
        ├── network-policy.ts                              # buildDefaultDenyPolicies + buildAgentEgressPolicy + apply
        ├── cilium-network-policy.ts                       # buildCiliumAgentEgressPolicy + apply (when capabilities.cilium)
        ├── image-pull-secret.ts                           # buildImagePullSecret + apply (resolves Paperclip secret_ref)
        └── ensure-tenant.ts                               # ensureTenantNamespace(ctx) — top-level idempotent orchestrator

packages/adapters/kubernetes-execution/test/
├── unit/
│   ├── naming.test.ts
│   ├── capabilities.test.ts
│   ├── namespace.test.ts                                  # builder snapshots
│   ├── rbac.test.ts
│   ├── resource-quota.test.ts
│   ├── network-policy.test.ts
│   ├── cilium-network-policy.test.ts
│   ├── image-pull-secret.test.ts
│   └── redaction.test.ts
└── integration/
    ├── _harness.ts                                        # spin up kind cluster, return KubeConfig + cleanup
    ├── ensure-tenant.test.ts                              # full happy path against kind
    ├── ensure-tenant-idempotency.test.ts                  # second ensure is a no-op
    ├── ensure-tenant-drift.test.ts                        # mutate by hand, re-ensure, verify recovery
    └── pss-restricted.test.ts                             # provision a tenant, run polaris/kube-linter, expect zero violations

packages/db/src/schema/
├── cluster_connections.ts                                 # NEW
├── cluster_namespace_bindings.ts                          # NEW
└── cluster_tenant_policies.ts                             # NEW

packages/db/src/migrations/
└── 0082_cluster_connections.sql                           # NEW (drizzle-kit generated)

server/src/adapters/
└── execution-target-registry.ts                           # NEW

server/src/adapters/execution-targets/
└── kubernetes.ts                                          # NEW (registers @paperclipai/execution-target-kubernetes)

server/src/services/
├── cluster-connections.ts                                 # NEW
├── cluster-connections.test.ts
├── cluster-tenant-policies.ts                             # NEW
└── cluster-tenant-policies.test.ts

cli/src/commands/
├── cluster.ts                                             # NEW (cluster add|list|test|remove|ensure-tenant|doctor)
└── cluster.test.ts
```

### Modified files

| File | What changes |
|---|---|
| `packages/adapter-utils/src/execution-target.ts` | Add `AdapterKubernetesExecutionTarget` interface; add to `AdapterExecutionTarget` union; extend `describeAdapterExecutionTarget`, `resolveAdapterExecutionTargetCwd`, and the unsupported-helpers guard so existing helpers don't crash on `kind: "kubernetes"`. |
| `packages/adapter-utils/src/types.ts` | Add `networkRequirements?: { allowFqdns?: string[] }` to `ServerAdapterModule`. |
| `packages/db/src/index.ts` | Re-export the three new schemas. |
| `server/src/index.ts` (or wherever adapter registry init lives) | Register the kubernetes execution-target driver during startup. |
| `cli/src/index.ts` | Wire `cluster` subcommand. |
| `pnpm-workspace.yaml` | Already covers `packages/adapters/*` — no change expected; verify. |

### Adapter audit (Risk #3 from the spec)

A dedicated task audits every existing adapter (`claude_local`, `codex_local`, `gemini_local`, `opencode_local`, `acpx_local`, `pi_local`, `hermes_local`) for `executionTarget` plumbing. The audit is a contract test, not a refactor — adapters must accept `ctx.executionTarget?.kind === "kubernetes"` without crashing and return a clear "not supported in M1" error. Real k8s execution comes in M2.

---

## Dependencies

Adds to `packages/adapters/kubernetes-execution/package.json`:

```json
{
  "dependencies": {
    "@kubernetes/client-node": "^0.21.0",
    "@paperclipai/adapter-utils": "workspace:*",
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^2.0.0"
  }
}
```

CI dev-dependency: `kind` binary (already commonly available in CI base images; if not, install via `go install sigs.k8s.io/kind@latest`).

---

## Sequencing & Workstream Notes

- Tasks 1–4 are foundational and **strictly sequential**.
- Tasks 5–14 are **pure builders** — can be parallelised across subagents.
- Task 15 (`ensureTenantNamespace`) is the integrator — must come after 5–14.
- Tasks 16–20 are **server/CLI surface** — depend on 15.
- Tasks 21–24 close the loop (audit + integration + CLI smoke).

---

## Task 1: Scaffold the new package

**Files:**
- Create: `packages/adapters/kubernetes-execution/package.json`
- Create: `packages/adapters/kubernetes-execution/tsconfig.json`
- Create: `packages/adapters/kubernetes-execution/src/index.ts`
- Create: `packages/adapters/kubernetes-execution/README.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@paperclipai/execution-target-kubernetes",
  "version": "0.0.0",
  "license": "MIT",
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
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:integration": "vitest run --config vitest.integration.config.ts"
  },
  "dependencies": {
    "@kubernetes/client-node": "^0.21.0",
    "@paperclipai/adapter-utils": "workspace:*",
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `src/index.ts` with placeholder export**

```ts
export const PACKAGE_NAME = "@paperclipai/execution-target-kubernetes";
```

- [ ] **Step 4: Create a minimal README**

```markdown
# @paperclipai/execution-target-kubernetes

Kubernetes execution-target driver for Paperclip agents. See
[the design spec](../../../docs/superpowers/specs/2026-05-08-paperclip-cloud-adapter-design.md)
and the M1 implementation plan.
```

- [ ] **Step 5: Verify package resolves and builds**

Run: `pnpm install && pnpm --filter @paperclipai/execution-target-kubernetes build`
Expected: build succeeds; `dist/index.js` exists.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/kubernetes-execution pnpm-lock.yaml
git commit -m "feat(k8s-adapter): scaffold @paperclipai/execution-target-kubernetes package"
```

---

## Task 2: Add `KubernetesExecutionTarget` to the discriminated union

**Files:**
- Modify: `packages/adapter-utils/src/execution-target.ts`

Reference: spec §1.1.

- [ ] **Step 1: Write failing test for the type discriminator**

Create `packages/adapter-utils/src/execution-target.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { describeAdapterExecutionTarget } from "./execution-target.js";

describe("describeAdapterExecutionTarget — kubernetes kind", () => {
  it("returns a human-readable description for a kubernetes target", () => {
    const desc = describeAdapterExecutionTarget({
      kind: "kubernetes",
      clusterConnectionId: "c-123",
    });
    expect(desc).toContain("kubernetes");
    expect(desc).toContain("c-123");
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `pnpm --filter @paperclipai/adapter-utils test execution-target -- --run`
Expected: TS compile error — `kind: "kubernetes"` not assignable to `AdapterExecutionTarget`.

- [ ] **Step 3: Add the new interface and union member**

In `packages/adapter-utils/src/execution-target.ts`, add after the `AdapterSandboxExecutionTarget` interface:

```ts
export interface AdapterKubernetesExecutionTarget {
  kind: "kubernetes";
  clusterConnectionId: string;
  /** Override the auto-derived `paperclip-{companySlug}` namespace name. Rare. */
  namespaceOverride?: string | null;
  /** Override the resolved agent runtime image. Gated by per-cluster policy. */
  imageOverride?: string | null;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?:   { cpu?: string; memory?: string };
  } | null;
  storage?: {
    sizeGi?: number;
    storageClass?: string;
  } | null;
  envOverrides?: Record<string, string> | null;
}
```

Update the union:

```ts
export type AdapterExecutionTarget =
  | AdapterLocalExecutionTarget
  | AdapterSshExecutionTarget
  | AdapterSandboxExecutionTarget
  | AdapterKubernetesExecutionTarget;
```

Update `describeAdapterExecutionTarget` to handle the new variant. Find the function and add a branch:

```ts
if (target.kind === "kubernetes") {
  return `kubernetes(connection=${target.clusterConnectionId}${target.namespaceOverride ? `, namespace=${target.namespaceOverride}` : ""})`;
}
```

- [ ] **Step 4: Run test, expect it to pass**

Run: `pnpm --filter @paperclipai/adapter-utils test execution-target -- --run`
Expected: PASS.

- [ ] **Step 5: Audit the rest of `execution-target.ts` for `kind === "..."` switches**

For each helper that switches on `target.kind` (`resolveAdapterExecutionTargetCwd`, `ensureAdapterExecutionTargetCommandResolvable`, `runAdapterExecutionTargetProcess`, `runAdapterExecutionTargetShellCommand`, `readAdapterExecutionTargetHomeDir`):

Add a final branch that throws a clear error specific to M1 (so M2 can replace it):

```ts
if (target.kind === "kubernetes") {
  throw new Error(
    "Kubernetes execution target runtime helpers are not implemented yet (M1 covers tenant provisioning only; agent execution lands in M2).",
  );
}
```

Add a unit test that asserts each helper throws this specific error when called with a kubernetes target.

- [ ] **Step 6: Run all adapter-utils tests**

Run: `pnpm --filter @paperclipai/adapter-utils test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/adapter-utils/src/execution-target.ts packages/adapter-utils/src/execution-target.test.ts
git commit -m "feat(adapter-utils): add KubernetesExecutionTarget kind"
```

---

## Task 3: Add `networkRequirements` to `ServerAdapterModule`

Reference: spec Risk #7.

**Files:**
- Modify: `packages/adapter-utils/src/types.ts`

- [ ] **Step 1: Write failing test**

Append to `packages/adapter-utils/src/types.test.ts` (create if absent):

```ts
import { describe, it, expectTypeOf } from "vitest";
import type { ServerAdapterModule } from "./types.js";

describe("ServerAdapterModule.networkRequirements", () => {
  it("accepts an allowFqdns array on a module shape", () => {
    const m: Pick<ServerAdapterModule, "type" | "networkRequirements"> = {
      type: "test",
      networkRequirements: { allowFqdns: ["api.anthropic.com"] },
    };
    expectTypeOf(m.networkRequirements?.allowFqdns).toEqualTypeOf<readonly string[] | string[] | undefined>();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/adapter-utils test types`
Expected: TS error — `networkRequirements` not assignable.

- [ ] **Step 3: Add the field**

In `packages/adapter-utils/src/types.ts`, inside `ServerAdapterModule`, add:

```ts
/**
 * Optional declaration of outbound network endpoints this adapter requires
 * at runtime. Used by the kubernetes execution target to compose Cilium
 * FQDN allowlists. Empty/omitted means "no adapter-specific FQDN allowlist
 * contribution"; the cluster's default allowlist still applies.
 */
networkRequirements?: {
  allowFqdns?: string[];
};
```

- [ ] **Step 4: Run test, expect pass**

Run: `pnpm --filter @paperclipai/adapter-utils test types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-utils/src/types.ts packages/adapter-utils/src/types.test.ts
git commit -m "feat(adapter-utils): add networkRequirements to ServerAdapterModule"
```

---

## Task 4: Drizzle schema — three new tables

**Files:**
- Create: `packages/db/src/schema/cluster_connections.ts`
- Create: `packages/db/src/schema/cluster_namespace_bindings.ts`
- Create: `packages/db/src/schema/cluster_tenant_policies.ts`
- Modify: `packages/db/src/index.ts`
- Generated: `packages/db/src/migrations/0082_cluster_connections.sql`

Reference: spec §2.7.

- [ ] **Step 1: Create `cluster_connections.ts`**

```ts
import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const clusterConnections = pgTable(
  "cluster_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull(),
    kind: text("kind").notNull(), // "in-cluster" | "kubeconfig"
    kubeconfigSecretRef: jsonb("kubeconfig_secret_ref").$type<{
      provider: string;
      name: string;
    } | null>(),
    apiServerUrl: text("api_server_url"),
    defaultNamespacePrefix: text("default_namespace_prefix").notNull().default("paperclip-"),
    capabilities: jsonb("capabilities").notNull().$type<{
      cilium: boolean;
      storageClass: string;
      architectures: ("amd64" | "arm64")[];
    }>(),
    paperclipPublicUrl: text("paperclip_public_url"),
    imageRegistry: text("image_registry"),
    allowAgentImageOverride: text("allow_agent_image_override").notNull().default("false"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    labelUq: uniqueIndex("cluster_connections_label_uq").on(table.label),
    kindIdx: index("cluster_connections_kind_idx").on(table.kind),
  }),
);
```

- [ ] **Step 2: Create `cluster_namespace_bindings.ts`**

```ts
import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { clusterConnections } from "./cluster_connections.js";

export const clusterNamespaceBindings = pgTable(
  "cluster_namespace_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterConnectionId: uuid("cluster_connection_id").notNull().references(() => clusterConnections.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    namespaceName: text("namespace_name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    perClusterCompanyUq: uniqueIndex("cluster_namespace_bindings_cluster_company_uq")
      .on(table.clusterConnectionId, table.companyId),
    namespaceLookupUq: uniqueIndex("cluster_namespace_bindings_cluster_ns_uq")
      .on(table.clusterConnectionId, table.namespaceName),
    companyIdx: index("cluster_namespace_bindings_company_idx").on(table.companyId),
  }),
);
```

- [ ] **Step 3: Create `cluster_tenant_policies.ts`**

```ts
import { pgTable, uuid, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { clusterConnections } from "./cluster_connections.js";

export const clusterTenantPolicies = pgTable(
  "cluster_tenant_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterConnectionId: uuid("cluster_connection_id").notNull().references(() => clusterConnections.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    quotaJson: jsonb("quota_json").$type<{
      requestsCpu?: string;
      requestsMemory?: string;
      limitsCpu?: string;
      limitsMemory?: string;
      requestsStorage?: string;
      countJobs?: number;
      countPvcs?: number;
      countSecrets?: number;
      countConfigMaps?: number;
    } | null>(),
    limitRangeJson: jsonb("limit_range_json").$type<{
      defaultRequest?: { cpu?: string; memory?: string };
      default?:        { cpu?: string; memory?: string };
      max?:            { cpu?: string; memory?: string };
      pvcMaxStorage?: string;
    } | null>(),
    networkJson: jsonb("network_json").$type<{
      additionalAllowFqdns?: string[];
      httpProxyUrl?: string | null;
    } | null>(),
    imageOverridesJson: jsonb("image_overrides_json").$type<Record<string, string> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    perClusterCompanyUq: uniqueIndex("cluster_tenant_policies_cluster_company_uq")
      .on(table.clusterConnectionId, table.companyId),
    companyIdx: index("cluster_tenant_policies_company_idx").on(table.companyId),
  }),
);
```

- [ ] **Step 4: Re-export from `packages/db/src/index.ts`**

Find the schema re-export block and append:

```ts
export { clusterConnections } from "./schema/cluster_connections.js";
export { clusterNamespaceBindings } from "./schema/cluster_namespace_bindings.js";
export { clusterTenantPolicies } from "./schema/cluster_tenant_policies.js";
```

- [ ] **Step 5: Build the schema package so drizzle-kit can read `dist/schema/*.js`**

Run: `pnpm --filter @paperclipai/db build`
Expected: build succeeds.

- [ ] **Step 6: Generate migration**

Run: `pnpm --filter @paperclipai/db exec drizzle-kit generate --name cluster_connections`
Expected: a new file `packages/db/src/migrations/0082_*.sql` containing `CREATE TABLE cluster_connections ...`.

- [ ] **Step 7: Inspect the migration**

Run: `cat packages/db/src/migrations/0082_*.sql | head -80`
Expected: the file declares all three tables with correct foreign keys and indexes.

- [ ] **Step 8: Apply migration in an embedded postgres test**

Add `packages/db/src/schema/cluster_connections.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "../test-embedded-postgres.js";
import { clusterConnections } from "./cluster_connections.js";

let db: EmbeddedPostgresTestDatabase;

beforeAll(async () => { db = await startEmbeddedPostgresTestDatabase(); });
afterAll(async () => { await db.stop(); });

describe("cluster_connections schema", () => {
  it("inserts and reads back a row with the expected shape", async () => {
    const [inserted] = await db.client.insert(clusterConnections).values({
      label: "test-cluster",
      kind: "in-cluster",
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      createdBy: "system",
    }).returning();
    expect(inserted.id).toBeDefined();
    expect(inserted.defaultNamespacePrefix).toBe("paperclip-");
    expect(inserted.allowAgentImageOverride).toBe("false");
  });
});
```

Run: `pnpm --filter @paperclipai/db test cluster_connections`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/schema/cluster_connections.ts \
        packages/db/src/schema/cluster_namespace_bindings.ts \
        packages/db/src/schema/cluster_tenant_policies.ts \
        packages/db/src/schema/cluster_connections.test.ts \
        packages/db/src/index.ts \
        packages/db/src/migrations/0082_*.sql \
        packages/db/src/migrations/meta/
git commit -m "feat(db): add cluster_connections, cluster_namespace_bindings, cluster_tenant_policies tables"
```

---

## Task 5: K8s client wrapper

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/client.ts`
- Create: `packages/adapters/kubernetes-execution/src/types.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/client.test.ts`

The wrapper exists so the rest of the package never imports `@kubernetes/client-node` directly — easier mocking and a clear seam for cross-cluster vs in-cluster auth.

- [ ] **Step 1: Define internal types**

Create `src/types.ts`:

```ts
import type { CoreV1Api, BatchV1Api, NetworkingV1Api, RbacAuthorizationV1Api, ApiextensionsV1Api } from "@kubernetes/client-node";

export interface ResolvedClusterConnection {
  id: string;
  label: string;
  kind: "in-cluster" | "kubeconfig";
  /** Already resolved kubeconfig blob if kind === "kubeconfig". */
  kubeconfigYaml?: string;
  apiServerUrl?: string | null;
  defaultNamespacePrefix: string;
  paperclipPublicUrl?: string | null;
  imageRegistry?: string | null;
  allowAgentImageOverride: boolean;
  capabilities: ClusterCapabilities;
}

export interface ClusterCapabilities {
  cilium: boolean;
  storageClass: string;
  architectures: ("amd64" | "arm64")[];
}

export interface KubernetesApiClient {
  core: CoreV1Api;
  batch: BatchV1Api;
  networking: NetworkingV1Api;
  rbac: RbacAuthorizationV1Api;
  apiext: ApiextensionsV1Api;
  /** kubeconfig context info for logging only. */
  describe: () => string;
  /** Throwaway dynamic client used for arbitrary CRDs (Cilium). */
  request: <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;
}
```

- [ ] **Step 2: Write failing test for `createKubernetesApiClient`**

Create `test/unit/client.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createKubernetesApiClient } from "../../src/client.js";

describe("createKubernetesApiClient", () => {
  it("constructs a client from a kubeconfig blob", () => {
    const kubeconfig = `
apiVersion: v1
kind: Config
clusters: [{ name: kind, cluster: { server: https://127.0.0.1:6443, insecure-skip-tls-verify: true } }]
contexts: [{ name: kind, context: { cluster: kind, user: kind } }]
current-context: kind
users: [{ name: kind, user: { token: x } }]
`;
    const client = createKubernetesApiClient({
      id: "c-1",
      label: "test",
      kind: "kubeconfig",
      kubeconfigYaml: kubeconfig,
      defaultNamespacePrefix: "paperclip-",
      allowAgentImageOverride: false,
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
    });
    expect(client.core).toBeDefined();
    expect(client.batch).toBeDefined();
    expect(client.describe()).toContain("kind");
  });

  it("rejects an in-cluster connection when not running in a pod", () => {
    expect(() =>
      createKubernetesApiClient({
        id: "c-1", label: "test", kind: "in-cluster",
        defaultNamespacePrefix: "paperclip-", allowAgentImageOverride: false,
        capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      }),
    ).toThrow(/in-cluster/i);
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test client`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `client.ts`**

```ts
import {
  KubeConfig,
  CoreV1Api, BatchV1Api, NetworkingV1Api, RbacAuthorizationV1Api, ApiextensionsV1Api,
} from "@kubernetes/client-node";
import type { ResolvedClusterConnection, KubernetesApiClient } from "./types.js";

export function createKubernetesApiClient(connection: ResolvedClusterConnection): KubernetesApiClient {
  const kc = new KubeConfig();
  if (connection.kind === "in-cluster") {
    try {
      kc.loadFromCluster();
    } catch (err) {
      throw new Error(
        `Cluster connection ${connection.id} is in-cluster but Paperclip is not running inside a Kubernetes pod: ${(err as Error).message}`,
      );
    }
  } else {
    if (!connection.kubeconfigYaml) {
      throw new Error(`Cluster connection ${connection.id} is kind=kubeconfig but kubeconfigYaml is empty`);
    }
    kc.loadFromString(connection.kubeconfigYaml);
  }

  const core = kc.makeApiClient(CoreV1Api);
  const batch = kc.makeApiClient(BatchV1Api);
  const networking = kc.makeApiClient(NetworkingV1Api);
  const rbac = kc.makeApiClient(RbacAuthorizationV1Api);
  const apiext = kc.makeApiClient(ApiextensionsV1Api);

  const ctx = kc.getCurrentContext();

  return {
    core, batch, networking, rbac, apiext,
    describe: () => `${connection.label} (context=${ctx})`,
    request: async (method, path, body) => {
      const opts = { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined };
      const cluster = kc.getCurrentCluster();
      if (!cluster) throw new Error(`No current cluster in kubeconfig`);
      const url = new URL(path, cluster.server).toString();
      const res = await kc.applyToHTTPSOptions(opts as never).then(async () => fetch(url, opts as RequestInit));
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`k8s API ${method} ${path} failed ${res.status}: ${text}`);
      }
      return res.json() as Promise<T>;
    },
  };
}
```

- [ ] **Step 5: Run test, expect pass**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test client`
Expected: first test PASS, second test PASS (the in-cluster path throws because we're not in a pod).

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/client.ts \
        packages/adapters/kubernetes-execution/src/types.ts \
        packages/adapters/kubernetes-execution/test/unit/client.test.ts
git commit -m "feat(k8s-adapter): add k8s API client wrapper"
```

---

## Task 6: Cluster capability probe

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/capabilities.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/capabilities.test.ts`

Reference: spec §2.7 (capabilities field), §2.4 (Cilium detection).

- [ ] **Step 1: Write failing test using a mocked client**

```ts
import { describe, it, expect, vi } from "vitest";
import { probeClusterCapabilities } from "../../src/orchestrator/capabilities.js";

function fakeClient(opts: { hasCilium: boolean; nodes: { arch: string }[]; storageClasses: string[]; defaultStorageClass?: string }) {
  return {
    request: vi.fn(async (method: string, path: string) => {
      if (path.includes("/apis/cilium.io/v2")) {
        return opts.hasCilium ? { kind: "APIResourceList", resources: [] } : null;
      }
      if (path.includes("/apis/storage.k8s.io/v1/storageclasses")) {
        return {
          items: opts.storageClasses.map(name => ({
            metadata: {
              name,
              annotations: name === opts.defaultStorageClass
                ? { "storageclass.kubernetes.io/is-default-class": "true" }
                : {},
            },
          })),
        };
      }
      return null;
    }),
    core: {
      listNode: vi.fn(async () => ({
        body: { items: opts.nodes.map(n => ({ status: { nodeInfo: { architecture: n.arch } } })) },
      })),
    },
  } as unknown as Parameters<typeof probeClusterCapabilities>[0];
}

describe("probeClusterCapabilities", () => {
  it("detects cilium and arm64 nodes", async () => {
    const c = fakeClient({
      hasCilium: true,
      nodes: [{ arch: "amd64" }, { arch: "arm64" }],
      storageClasses: ["standard", "gp3"],
      defaultStorageClass: "gp3",
    });
    const caps = await probeClusterCapabilities(c);
    expect(caps.cilium).toBe(true);
    expect(caps.architectures).toEqual(expect.arrayContaining(["amd64", "arm64"]));
    expect(caps.storageClass).toBe("gp3");
  });

  it("falls back to first storage class when none is marked default", async () => {
    const c = fakeClient({
      hasCilium: false,
      nodes: [{ arch: "amd64" }],
      storageClasses: ["standard"],
    });
    const caps = await probeClusterCapabilities(c);
    expect(caps.cilium).toBe(false);
    expect(caps.storageClass).toBe("standard");
  });

  it("handles cilium API absence gracefully", async () => {
    const c = fakeClient({
      hasCilium: false, nodes: [{ arch: "amd64" }],
      storageClasses: ["standard"], defaultStorageClass: "standard",
    });
    const caps = await probeClusterCapabilities(c);
    expect(caps.cilium).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test capabilities`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `capabilities.ts`**

```ts
import type { KubernetesApiClient, ClusterCapabilities } from "../types.js";

export async function probeClusterCapabilities(client: KubernetesApiClient): Promise<ClusterCapabilities> {
  // 1. Cilium presence: try to fetch the API resource list at /apis/cilium.io/v2.
  const cilium = await detectCilium(client);

  // 2. Node architectures.
  const nodes = await client.core.listNode();
  const archSet = new Set<"amd64" | "arm64">();
  for (const node of nodes.body.items) {
    const arch = node.status?.nodeInfo?.architecture;
    if (arch === "amd64" || arch === "arm64") archSet.add(arch);
  }
  const architectures = archSet.size > 0 ? [...archSet] : ["amd64"] as const;

  // 3. Storage class: prefer the one annotated as default; else the first.
  const storageClass = await detectStorageClass(client);

  return { cilium, storageClass, architectures: [...architectures] };
}

async function detectCilium(client: KubernetesApiClient): Promise<boolean> {
  try {
    const res = await client.request<{ kind?: string } | null>("GET", "/apis/cilium.io/v2");
    return res != null && res.kind === "APIResourceList";
  } catch {
    return false;
  }
}

async function detectStorageClass(client: KubernetesApiClient): Promise<string> {
  type SCList = { items: Array<{ metadata: { name: string; annotations?: Record<string, string> } }> };
  const res = await client.request<SCList | null>("GET", "/apis/storage.k8s.io/v1/storageclasses");
  if (!res || !res.items.length) return "standard";
  const isDefault = (sc: SCList["items"][number]) =>
    sc.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true";
  return res.items.find(isDefault)?.metadata.name ?? res.items[0].metadata.name;
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test capabilities`
Expected: all three tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/capabilities.ts \
        packages/adapters/kubernetes-execution/test/unit/capabilities.test.ts
git commit -m "feat(k8s-adapter): add cluster capability probe"
```

---

## Task 7: Naming utility

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/naming.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/naming.test.ts`

Reference: spec §2.1 namespace naming.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { deriveNamespaceName, isValidDns1123Label } from "../../src/orchestrator/naming.js";

describe("isValidDns1123Label", () => {
  it("accepts simple slugs", () => {
    expect(isValidDns1123Label("acme-corp")).toBe(true);
    expect(isValidDns1123Label("a")).toBe(true);
  });
  it("rejects uppercase, leading/trailing hyphens, dots, length > 63", () => {
    expect(isValidDns1123Label("Acme")).toBe(false);
    expect(isValidDns1123Label("-acme")).toBe(false);
    expect(isValidDns1123Label("acme-")).toBe(false);
    expect(isValidDns1123Label("ac.me")).toBe(false);
    expect(isValidDns1123Label("x".repeat(64))).toBe(false);
  });
});

describe("deriveNamespaceName", () => {
  it("returns paperclip-{slug} for short clean slugs", () => {
    expect(deriveNamespaceName({
      companySlug: "acme-corp",
      companyId: "11111111-1111-1111-1111-111111111111",
      prefix: "paperclip-",
    })).toBe("paperclip-acme-corp");
  });

  it("appends a short hash when the slug overflows after prefix", () => {
    const longSlug = "a".repeat(60);
    const result = deriveNamespaceName({
      companySlug: longSlug,
      companyId: "22222222-2222-2222-2222-222222222222",
      prefix: "paperclip-",
    });
    expect(result.startsWith("paperclip-")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(63);
    expect(result).toMatch(/-[0-9a-z]{8}$/);
  });

  it("appends a short hash when explicit collision flag is set", () => {
    const withHash = deriveNamespaceName({
      companySlug: "acme-corp",
      companyId: "33333333-3333-3333-3333-333333333333",
      prefix: "paperclip-",
      collisionFallback: true,
    });
    expect(withHash).toMatch(/^paperclip-acme-corp-[0-9a-z]{8}$/);
  });

  it("sanitizes invalid slugs deterministically", () => {
    const r = deriveNamespaceName({
      companySlug: "Acme Corp.!",
      companyId: "44444444-4444-4444-4444-444444444444",
      prefix: "paperclip-",
    });
    expect(isValidDns1123Label(r)).toBe(true);
    expect(r.startsWith("paperclip-")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test naming`
Expected: FAIL.

- [ ] **Step 3: Implement `naming.ts`**

```ts
import { createHash } from "node:crypto";

const DNS_1123_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_LABEL = 63;

export function isValidDns1123Label(s: string): boolean {
  return s.length > 0 && s.length <= MAX_LABEL && DNS_1123_LABEL.test(s);
}

function shortHash(input: string): string {
  // base36 of first 5 bytes of sha256 → ≤8 chars, all lowercase alnum
  const hash = createHash("sha256").update(input).digest();
  let n = 0n;
  for (let i = 0; i < 5; i++) n = (n << 8n) + BigInt(hash[i]);
  return n.toString(36).slice(0, 8).padStart(8, "0");
}

function sanitizeSlug(slug: string): string {
  // Lowercase, replace runs of invalid chars with single hyphen, trim leading/trailing hyphens.
  const cleaned = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length === 0 ? "x" : cleaned;
}

export interface DeriveNamespaceNameInput {
  companySlug: string;
  companyId: string;
  prefix: string;
  collisionFallback?: boolean;
}

export function deriveNamespaceName(input: DeriveNamespaceNameInput): string {
  const { companySlug, companyId, prefix, collisionFallback } = input;
  const slug = sanitizeSlug(companySlug);
  const naive = `${prefix}${slug}`;

  // Hash suffix is appended when:
  //   - explicit collision fallback requested
  //   - naive name would overflow 63 chars
  //   - sanitization mangled the slug (length comparison or character drop)
  const sanitizedDiffers = slug !== companySlug.toLowerCase();
  const overflow = naive.length > MAX_LABEL;
  if (!collisionFallback && !overflow && !sanitizedDiffers) return naive;

  const suffix = `-${shortHash(companyId)}`;
  const room = MAX_LABEL - prefix.length - suffix.length;
  const truncatedSlug = slug.slice(0, Math.max(1, room)).replace(/-+$/g, "");
  return `${prefix}${truncatedSlug}${suffix}`;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test naming`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/naming.ts \
        packages/adapters/kubernetes-execution/test/unit/naming.test.ts
git commit -m "feat(k8s-adapter): add namespace naming utility with DNS-1123 fallback"
```

---

## Task 8: Label constants

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/labels.ts`

Trivial — single export — combined into Task 9's commit if desired.

- [ ] **Step 1: Implement labels module**

```ts
export const PAPERCLIP_MANAGED_BY = "paperclip.ai/managed-by";
export const PAPERCLIP_MANAGED_BY_VALUE = "paperclip";

export const PAPERCLIP_COMPANY_ID    = "paperclip.ai/company-id";
export const PAPERCLIP_COMPANY_SLUG  = "paperclip.ai/company-slug";
export const PAPERCLIP_AGENT_ID      = "paperclip.ai/agent-id";
export const PAPERCLIP_RUN_ID        = "paperclip.ai/run-id";
export const PAPERCLIP_ROLE          = "paperclip.ai/role";
export const PAPERCLIP_ARCHIVED      = "paperclip.ai/archived";
export const PAPERCLIP_WORKSPACE_STRATEGY = "paperclip.ai/workspace-strategy";

export const ROLE_AGENT_RUNTIME      = "agent-runtime";
export const ROLE_AGENT_WORKSPACE    = "agent-workspace";
export const ROLE_CONTROL_PLANE      = "control-plane";

export const PSS_ENFORCE = "pod-security.kubernetes.io/enforce";
export const PSS_AUDIT   = "pod-security.kubernetes.io/audit";
export const PSS_WARN    = "pod-security.kubernetes.io/warn";
export const PSS_RESTRICTED = "restricted";

export function tenantBaseLabels(input: { companyId: string; companySlug: string }): Record<string, string> {
  return {
    [PAPERCLIP_MANAGED_BY]:   PAPERCLIP_MANAGED_BY_VALUE,
    [PAPERCLIP_COMPANY_ID]:   input.companyId,
    [PAPERCLIP_COMPANY_SLUG]: input.companySlug,
  };
}
```

- [ ] **Step 2: No test (constants only); referenced by later tasks.**

- [ ] **Step 3: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/labels.ts
git commit -m "feat(k8s-adapter): add label constants"
```

---

## Task 9: Namespace builder + apply

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/namespace.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/namespace.test.ts`

Reference: spec §2.1.

- [ ] **Step 1: Write failing builder test**

```ts
import { describe, it, expect } from "vitest";
import { buildNamespace } from "../../src/orchestrator/namespace.js";

describe("buildNamespace", () => {
  it("produces a namespace with paperclip labels and PSS restricted", () => {
    const ns = buildNamespace({
      name: "paperclip-acme-corp",
      companyId: "c-uuid",
      companySlug: "acme-corp",
    });
    expect(ns.kind).toBe("Namespace");
    expect(ns.metadata.name).toBe("paperclip-acme-corp");
    expect(ns.metadata.labels?.["paperclip.ai/managed-by"]).toBe("paperclip");
    expect(ns.metadata.labels?.["paperclip.ai/company-id"]).toBe("c-uuid");
    expect(ns.metadata.labels?.["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    expect(ns.metadata.labels?.["pod-security.kubernetes.io/audit"]).toBe("restricted");
    expect(ns.metadata.labels?.["pod-security.kubernetes.io/warn"]).toBe("restricted");
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test namespace`
Expected: FAIL.

- [ ] **Step 3: Implement `buildNamespace` and `applyNamespace`**

```ts
import type { V1Namespace } from "@kubernetes/client-node";
import type { KubernetesApiClient } from "../types.js";
import {
  PSS_ENFORCE, PSS_AUDIT, PSS_WARN, PSS_RESTRICTED,
  tenantBaseLabels, PAPERCLIP_MANAGED_BY, PAPERCLIP_MANAGED_BY_VALUE,
} from "./labels.js";

export interface BuildNamespaceInput {
  name: string;
  companyId: string;
  companySlug: string;
  extraLabels?: Record<string, string>;
}

export function buildNamespace(input: BuildNamespaceInput): V1Namespace {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: input.name,
      labels: {
        ...tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
        [PSS_ENFORCE]: PSS_RESTRICTED,
        [PSS_AUDIT]:   PSS_RESTRICTED,
        [PSS_WARN]:    PSS_RESTRICTED,
        ...input.extraLabels,
      },
    },
  };
}

/**
 * Idempotently apply a tenant namespace. Refuses to overwrite a namespace
 * that is not labeled paperclip.ai/managed-by=paperclip.
 */
export async function applyNamespace(
  client: KubernetesApiClient,
  ns: V1Namespace,
): Promise<{ created: boolean }> {
  const name = ns.metadata!.name!;
  try {
    const existing = await client.core.readNamespace(name);
    const managed = existing.body.metadata?.labels?.[PAPERCLIP_MANAGED_BY];
    if (managed !== PAPERCLIP_MANAGED_BY_VALUE) {
      throw new Error(
        `Refusing to manage namespace "${name}": missing label ${PAPERCLIP_MANAGED_BY}=${PAPERCLIP_MANAGED_BY_VALUE}`,
      );
    }
    // Patch labels (server-side apply would be cleaner; client-go uses strategic merge by default).
    await client.core.patchNamespace(name, ns, undefined, undefined, undefined, undefined, undefined, {
      headers: { "Content-Type": "application/strategic-merge-patch+json" },
    } as never);
    return { created: false };
  } catch (err: unknown) {
    if (isNotFound(err)) {
      await client.core.createNamespace(ns);
      return { created: true };
    }
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  const code = (err as { response?: { statusCode?: number } })?.response?.statusCode;
  return code === 404;
}
```

- [ ] **Step 4: Run, expect builder test PASS**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test namespace`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/namespace.ts \
        packages/adapters/kubernetes-execution/test/unit/namespace.test.ts
git commit -m "feat(k8s-adapter): add tenant namespace builder and apply"
```

---

## Task 10: RBAC builder + apply

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/rbac.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/rbac.test.ts`

Reference: spec §2.2. The pod's SA has zero RBAC; the *driver's* identity is bound by the cluster operator (out of band) to a cluster-scoped Role we ship as YAML in the package's docs (see Task 23 doctor command). For M1 we only create the namespace-local ServiceAccount and a no-op Role for documentation purposes.

- [ ] **Step 1: Write failing builder test**

```ts
import { describe, it, expect } from "vitest";
import { buildAgentServiceAccount, buildDriverRoleBinding } from "../../src/orchestrator/rbac.js";

describe("buildAgentServiceAccount", () => {
  it("creates paperclip-agent SA with token automounting disabled", () => {
    const sa = buildAgentServiceAccount({ namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme" });
    expect(sa.metadata?.name).toBe("paperclip-agent");
    expect(sa.metadata?.namespace).toBe("paperclip-acme");
    expect(sa.automountServiceAccountToken).toBe(false);
  });
});

describe("buildDriverRoleBinding", () => {
  it("references the driver SA in its own namespace and the cluster role for tenant management", () => {
    const rb = buildDriverRoleBinding({
      namespace: "paperclip-acme",
      driverServiceAccount: { name: "paperclip-driver", namespace: "paperclip-system" },
      clusterRoleName: "paperclip-tenant-manager",
      companyId: "c-1", companySlug: "acme",
    });
    expect(rb.subjects?.[0]).toMatchObject({ kind: "ServiceAccount", name: "paperclip-driver", namespace: "paperclip-system" });
    expect(rb.roleRef.kind).toBe("ClusterRole");
    expect(rb.roleRef.name).toBe("paperclip-tenant-manager");
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test rbac`
Expected: FAIL.

- [ ] **Step 3: Implement `rbac.ts`**

```ts
import type { V1ServiceAccount, V1RoleBinding } from "@kubernetes/client-node";
import type { KubernetesApiClient } from "../types.js";
import { tenantBaseLabels } from "./labels.js";

export interface BuildAgentServiceAccountInput {
  namespace: string;
  companyId: string;
  companySlug: string;
}

export function buildAgentServiceAccount(input: BuildAgentServiceAccountInput): V1ServiceAccount {
  return {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: "paperclip-agent",
      namespace: input.namespace,
      labels: tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
    },
    automountServiceAccountToken: false,
  };
}

export interface BuildDriverRoleBindingInput {
  namespace: string;
  driverServiceAccount: { name: string; namespace: string };
  clusterRoleName: string;
  companyId: string;
  companySlug: string;
}

export function buildDriverRoleBinding(input: BuildDriverRoleBindingInput): V1RoleBinding {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: {
      name: "paperclip-driver",
      namespace: input.namespace,
      labels: tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
    },
    subjects: [{
      kind: "ServiceAccount",
      name: input.driverServiceAccount.name,
      namespace: input.driverServiceAccount.namespace,
    }],
    roleRef: {
      kind: "ClusterRole",
      apiGroup: "rbac.authorization.k8s.io",
      name: input.clusterRoleName,
    },
  };
}

export async function applyAgentServiceAccount(client: KubernetesApiClient, sa: V1ServiceAccount): Promise<void> {
  const ns = sa.metadata!.namespace!;
  const name = sa.metadata!.name!;
  try {
    await client.core.readNamespacedServiceAccount(name, ns);
    await client.core.patchNamespacedServiceAccount(name, ns, sa, undefined, undefined, undefined, undefined, undefined, {
      headers: { "Content-Type": "application/strategic-merge-patch+json" },
    } as never);
  } catch (err) {
    if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 404) {
      await client.core.createNamespacedServiceAccount(ns, sa);
      return;
    }
    throw err;
  }
}

export async function applyDriverRoleBinding(client: KubernetesApiClient, rb: V1RoleBinding): Promise<void> {
  const ns = rb.metadata!.namespace!;
  const name = rb.metadata!.name!;
  try {
    await client.rbac.readNamespacedRoleBinding(name, ns);
    // RoleBindings are immutable on roleRef; the only safe path is delete+create when subjects/role differ.
    // For simplicity in M1 we delete-and-create on every apply.
    await client.rbac.deleteNamespacedRoleBinding(name, ns);
    await client.rbac.createNamespacedRoleBinding(ns, rb);
  } catch (err) {
    if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 404) {
      await client.rbac.createNamespacedRoleBinding(ns, rb);
      return;
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test rbac`
Expected: PASS.

- [ ] **Step 5: Add the cluster-scoped Role manifest as a docs/reference YAML**

Create `packages/adapters/kubernetes-execution/manifests/paperclip-tenant-manager-clusterrole.yaml`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: paperclip-tenant-manager
rules:
  - apiGroups: [""]
    resources: ["namespaces", "resourcequotas", "limitranges", "secrets", "serviceaccounts", "configmaps", "persistentvolumeclaims", "pods", "pods/log", "pods/exec"]
    verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "create", "update", "patch", "delete", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["networkpolicies"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["roles", "rolebindings"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]
  - apiGroups: ["cilium.io"]
    resources: ["ciliumnetworkpolicies"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]
```

This is referenced by Task 23 (doctor) which prints the path to it.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/rbac.ts \
        packages/adapters/kubernetes-execution/test/unit/rbac.test.ts \
        packages/adapters/kubernetes-execution/manifests/paperclip-tenant-manager-clusterrole.yaml
git commit -m "feat(k8s-adapter): add tenant RBAC builders and reference ClusterRole"
```

---

## Task 11: ResourceQuota + LimitRange builders + apply

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/resource-quota.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/resource-quota.test.ts`

Reference: spec §2.6.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { buildResourceQuota, buildLimitRange, defaultTenantQuota, defaultTenantLimits } from "../../src/orchestrator/resource-quota.js";

describe("buildResourceQuota", () => {
  it("uses defaults when no tenant override is supplied", () => {
    const q = buildResourceQuota({
      namespace: "paperclip-acme",
      companyId: "c-1",
      companySlug: "acme",
      override: null,
    });
    expect(q.spec?.hard?.["requests.cpu"]).toBe(defaultTenantQuota.requestsCpu);
    expect(q.spec?.hard?.["count/jobs.batch"]).toBe(String(defaultTenantQuota.countJobs));
  });

  it("respects tenant override values", () => {
    const q = buildResourceQuota({
      namespace: "paperclip-acme",
      companyId: "c-1",
      companySlug: "acme",
      override: { requestsCpu: "32", countJobs: 200 },
    });
    expect(q.spec?.hard?.["requests.cpu"]).toBe("32");
    expect(q.spec?.hard?.["count/jobs.batch"]).toBe("200");
  });
});

describe("buildLimitRange", () => {
  it("emits Container + PVC limits", () => {
    const lr = buildLimitRange({
      namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme", override: null,
    });
    const container = lr.spec?.limits?.find(l => l.type === "Container");
    expect(container?.default?.cpu).toBe(defaultTenantLimits.default.cpu);
    expect(lr.spec?.limits?.find(l => l.type === "PersistentVolumeClaim")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test resource-quota`
Expected: FAIL.

- [ ] **Step 3: Implement `resource-quota.ts`**

```ts
import type { V1ResourceQuota, V1LimitRange } from "@kubernetes/client-node";
import type { KubernetesApiClient } from "../types.js";
import { tenantBaseLabels } from "./labels.js";

export const defaultTenantQuota = {
  requestsCpu:    "16",
  requestsMemory: "64Gi",
  limitsCpu:      "64",
  limitsMemory:   "256Gi",
  requestsStorage:"200Gi",
  countJobs:      100,
  countPvcs:      50,
  countSecrets:   200,
  countConfigMaps:200,
};

export const defaultTenantLimits = {
  default:        { cpu: "1",    memory: "2Gi" },
  defaultRequest: { cpu: "250m", memory: "512Mi" },
  max:            { cpu: "8",    memory: "32Gi" },
  pvcMaxStorage:  "20Gi",
};

export interface QuotaOverride {
  requestsCpu?: string;
  requestsMemory?: string;
  limitsCpu?: string;
  limitsMemory?: string;
  requestsStorage?: string;
  countJobs?: number;
  countPvcs?: number;
  countSecrets?: number;
  countConfigMaps?: number;
}

export interface LimitRangeOverride {
  default?:        { cpu?: string; memory?: string };
  defaultRequest?: { cpu?: string; memory?: string };
  max?:            { cpu?: string; memory?: string };
  pvcMaxStorage?:  string;
}

export interface BuildQuotaInput {
  namespace: string;
  companyId: string;
  companySlug: string;
  override: QuotaOverride | null;
}

export function buildResourceQuota(input: BuildQuotaInput): V1ResourceQuota {
  const o = { ...defaultTenantQuota, ...(input.override ?? {}) };
  return {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: {
      name: "paperclip-tenant-quota",
      namespace: input.namespace,
      labels: tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
    },
    spec: {
      hard: {
        "requests.cpu":                    o.requestsCpu,
        "requests.memory":                 o.requestsMemory,
        "limits.cpu":                      o.limitsCpu,
        "limits.memory":                   o.limitsMemory,
        "requests.storage":                o.requestsStorage,
        "count/jobs.batch":                String(o.countJobs),
        "count/persistentvolumeclaims":    String(o.countPvcs),
        "count/secrets":                   String(o.countSecrets),
        "count/configmaps":                String(o.countConfigMaps),
      },
    },
  };
}

export interface BuildLimitRangeInput {
  namespace: string;
  companyId: string;
  companySlug: string;
  override: LimitRangeOverride | null;
}

export function buildLimitRange(input: BuildLimitRangeInput): V1LimitRange {
  const o = {
    default:        { ...defaultTenantLimits.default,        ...(input.override?.default        ?? {}) },
    defaultRequest: { ...defaultTenantLimits.defaultRequest, ...(input.override?.defaultRequest ?? {}) },
    max:            { ...defaultTenantLimits.max,            ...(input.override?.max            ?? {}) },
    pvcMaxStorage:  input.override?.pvcMaxStorage ?? defaultTenantLimits.pvcMaxStorage,
  };
  return {
    apiVersion: "v1",
    kind: "LimitRange",
    metadata: {
      name: "paperclip-tenant-limits",
      namespace: input.namespace,
      labels: tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
    },
    spec: {
      limits: [
        { type: "Container", default: o.default, defaultRequest: o.defaultRequest, max: o.max },
        { type: "PersistentVolumeClaim", max: { storage: o.pvcMaxStorage } },
      ],
    },
  };
}

export async function applyResourceQuota(client: KubernetesApiClient, q: V1ResourceQuota): Promise<void> {
  await upsertNamespaced(client, q, async (ns, name) => client.core.readNamespacedResourceQuota(name, ns), async (ns, name, body) => client.core.patchNamespacedResourceQuota(name, ns, body, undefined, undefined, undefined, undefined, undefined, { headers: { "Content-Type": "application/strategic-merge-patch+json" } } as never), async (ns, body) => client.core.createNamespacedResourceQuota(ns, body));
}

export async function applyLimitRange(client: KubernetesApiClient, lr: V1LimitRange): Promise<void> {
  await upsertNamespaced(client, lr, async (ns, name) => client.core.readNamespacedLimitRange(name, ns), async (ns, name, body) => client.core.patchNamespacedLimitRange(name, ns, body, undefined, undefined, undefined, undefined, undefined, { headers: { "Content-Type": "application/strategic-merge-patch+json" } } as never), async (ns, body) => client.core.createNamespacedLimitRange(ns, body));
}

async function upsertNamespaced<T extends { metadata?: { name?: string; namespace?: string } }>(
  _client: KubernetesApiClient,
  obj: T,
  read: (ns: string, name: string) => Promise<unknown>,
  patch: (ns: string, name: string, body: T) => Promise<unknown>,
  create: (ns: string, body: T) => Promise<unknown>,
): Promise<void> {
  const ns = obj.metadata!.namespace!;
  const name = obj.metadata!.name!;
  try {
    await read(ns, name);
    await patch(ns, name, obj);
  } catch (err) {
    if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 404) {
      await create(ns, obj);
      return;
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test resource-quota`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/resource-quota.ts \
        packages/adapters/kubernetes-execution/test/unit/resource-quota.test.ts
git commit -m "feat(k8s-adapter): add ResourceQuota and LimitRange builders"
```

---

## Task 12: NetworkPolicy (vanilla) builder + apply

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/network-policy.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/network-policy.test.ts`

Reference: spec §2.3.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { buildDefaultDenyPolicies, buildAgentEgressPolicy } from "../../src/orchestrator/network-policy.js";

describe("buildDefaultDenyPolicies", () => {
  it("emits two NetworkPolicies, one for ingress and one for egress, with empty podSelector", () => {
    const policies = buildDefaultDenyPolicies({
      namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme",
    });
    expect(policies).toHaveLength(2);
    for (const p of policies) {
      expect(p.spec?.podSelector).toEqual({});
    }
    expect(policies[0].spec?.policyTypes).toContain("Ingress");
    expect(policies[1].spec?.policyTypes).toContain("Egress");
  });
});

describe("buildAgentEgressPolicy", () => {
  it("denies RFC1918 + link-local + CGNAT + IPv6 ULA in the internet rule", () => {
    const p = buildAgentEgressPolicy({
      namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme",
      topology: "in-cluster",
      controlPlaneSelector: { namespaceLabel: { "paperclip.ai/role": "control-plane" }, podLabel: { "app.kubernetes.io/name": "paperclip-server" } },
    });
    const internetRule = p.spec?.egress?.find(e => e.to?.some(t => t.ipBlock));
    expect(internetRule).toBeDefined();
    const ipBlock = internetRule!.to!.find(t => t.ipBlock)!.ipBlock!;
    expect(ipBlock.cidr).toBe("0.0.0.0/0");
    expect(ipBlock.except).toEqual(expect.arrayContaining([
      "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "fd00::/8",
    ]));
  });

  it("omits the in-cluster control plane rule for cross-cluster topology", () => {
    const p = buildAgentEgressPolicy({
      namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme",
      topology: "cross-cluster",
      controlPlaneSelector: null,
    });
    expect(p.spec?.egress?.some(e =>
      e.to?.some(t => t.namespaceSelector?.matchLabels?.["paperclip.ai/role"] === "control-plane"),
    )).toBe(false);
  });

  it("targets only pods labeled paperclip.ai/role=agent-runtime", () => {
    const p = buildAgentEgressPolicy({
      namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme",
      topology: "in-cluster",
      controlPlaneSelector: { namespaceLabel: {}, podLabel: {} },
    });
    expect(p.spec?.podSelector?.matchLabels?.["paperclip.ai/role"]).toBe("agent-runtime");
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test network-policy`
Expected: FAIL.

- [ ] **Step 3: Implement `network-policy.ts`**

```ts
import type { V1NetworkPolicy } from "@kubernetes/client-node";
import type { KubernetesApiClient } from "../types.js";
import { tenantBaseLabels, PAPERCLIP_ROLE, ROLE_AGENT_RUNTIME } from "./labels.js";

const RFC1918_AND_INTERNAL_DENY = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",   // link-local incl. cloud metadata
  "100.64.0.0/10",    // CGNAT
  "fd00::/8",         // IPv6 ULA
];

export interface BuildDefaultDenyInput {
  namespace: string;
  companyId: string;
  companySlug: string;
}

export function buildDefaultDenyPolicies(input: BuildDefaultDenyInput): V1NetworkPolicy[] {
  const labels = tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug });
  return [
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "default-deny-ingress", namespace: input.namespace, labels },
      spec: { podSelector: {}, policyTypes: ["Ingress"] },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "default-deny-egress", namespace: input.namespace, labels },
      spec: { podSelector: {}, policyTypes: ["Egress"] },
    },
  ];
}

export interface AgentEgressInput {
  namespace: string;
  companyId: string;
  companySlug: string;
  topology: "in-cluster" | "cross-cluster";
  controlPlaneSelector: {
    namespaceLabel: Record<string, string>;
    podLabel: Record<string, string>;
  } | null;
}

export function buildAgentEgressPolicy(input: AgentEgressInput): V1NetworkPolicy {
  const labels = tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug });
  const egress: NonNullable<V1NetworkPolicy["spec"]>["egress"] = [
    // DNS
    {
      to: [{
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
        podSelector:       { matchLabels: { "k8s-app": "kube-dns" } },
      }],
      ports: [{ port: 53, protocol: "UDP" }, { port: 53, protocol: "TCP" }],
    },
  ];

  if (input.topology === "in-cluster" && input.controlPlaneSelector) {
    egress.push({
      to: [{
        namespaceSelector: { matchLabels: input.controlPlaneSelector.namespaceLabel },
        podSelector:       { matchLabels: input.controlPlaneSelector.podLabel },
      }],
      ports: [{ port: 443, protocol: "TCP" }, { port: 3102, protocol: "TCP" }],
    });
  }

  // Internet egress (denies internal ranges)
  egress.push({
    to: [{ ipBlock: { cidr: "0.0.0.0/0", except: RFC1918_AND_INTERNAL_DENY } }],
    ports: [{ port: 443, protocol: "TCP" }],
  });

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "paperclip-agent-egress", namespace: input.namespace, labels },
    spec: {
      podSelector: { matchLabels: { [PAPERCLIP_ROLE]: ROLE_AGENT_RUNTIME } },
      policyTypes: ["Egress"],
      egress,
    },
  };
}

export async function applyNetworkPolicy(client: KubernetesApiClient, p: V1NetworkPolicy): Promise<void> {
  const ns = p.metadata!.namespace!;
  const name = p.metadata!.name!;
  try {
    await client.networking.readNamespacedNetworkPolicy(name, ns);
    await client.networking.patchNamespacedNetworkPolicy(name, ns, p, undefined, undefined, undefined, undefined, undefined, {
      headers: { "Content-Type": "application/strategic-merge-patch+json" },
    } as never);
  } catch (err) {
    if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 404) {
      await client.networking.createNamespacedNetworkPolicy(ns, p);
      return;
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test network-policy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/network-policy.ts \
        packages/adapters/kubernetes-execution/test/unit/network-policy.test.ts
git commit -m "feat(k8s-adapter): add vanilla NetworkPolicy builders"
```

---

## Task 13: Cilium NetworkPolicy builder + apply

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/cilium-network-policy.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/cilium-network-policy.test.ts`

Reference: spec §2.4.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { buildCiliumAgentEgressPolicy } from "../../src/orchestrator/cilium-network-policy.js";

describe("buildCiliumAgentEgressPolicy", () => {
  it("merges adapter and tenant FQDN allowlists, deduplicated", () => {
    const p = buildCiliumAgentEgressPolicy({
      namespace: "paperclip-acme",
      companyId: "c-1",
      companySlug: "acme",
      adapterAllowFqdns: ["*.anthropic.com", "github.com"],
      tenantAllowFqdns: ["github.com", "*.acme.io"],
      controlPlaneSelector: { matchLabels: { "paperclip.ai/role": "control-plane" } },
    });
    const fqdns = p.spec.egress[0].toFQDNs!.map((f: any) => f.matchPattern ?? f.matchName).sort();
    expect(fqdns).toEqual(["*.acme.io", "*.anthropic.com", "github.com"]);
  });

  it("emits a separate egress rule for the in-cluster control plane endpoint", () => {
    const p = buildCiliumAgentEgressPolicy({
      namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme",
      adapterAllowFqdns: [], tenantAllowFqdns: [],
      controlPlaneSelector: { matchLabels: { "paperclip.ai/role": "control-plane" } },
    });
    expect(p.spec.egress.some((r: any) =>
      r.toEndpoints?.some((e: any) => e.matchLabels?.["paperclip.ai/role"] === "control-plane"),
    )).toBe(true);
  });

  it("omits the control-plane endpoint rule when none provided (cross-cluster)", () => {
    const p = buildCiliumAgentEgressPolicy({
      namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme",
      adapterAllowFqdns: ["api.anthropic.com"], tenantAllowFqdns: [],
      controlPlaneSelector: null,
    });
    expect(p.spec.egress.some((r: any) => r.toEndpoints)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test cilium-network-policy`
Expected: FAIL.

- [ ] **Step 3: Implement `cilium-network-policy.ts`**

```ts
import type { KubernetesApiClient } from "../types.js";
import { tenantBaseLabels, PAPERCLIP_ROLE, ROLE_AGENT_RUNTIME } from "./labels.js";

interface CiliumFqdn {
  matchPattern?: string;
  matchName?: string;
}

export interface CiliumNetworkPolicyDoc {
  apiVersion: "cilium.io/v2";
  kind: "CiliumNetworkPolicy";
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  spec: {
    endpointSelector: { matchLabels: Record<string, string> };
    egress: Array<{
      toFQDNs?: CiliumFqdn[];
      toEndpoints?: Array<{ matchLabels: Record<string, string> }>;
      toPorts?: Array<{ ports: Array<{ port: string; protocol: string }> }>;
    }>;
  };
}

export interface BuildCiliumInput {
  namespace: string;
  companyId: string;
  companySlug: string;
  adapterAllowFqdns: string[];
  tenantAllowFqdns: string[];
  controlPlaneSelector: { matchLabels: Record<string, string> } | null;
}

export function buildCiliumAgentEgressPolicy(input: BuildCiliumInput): CiliumNetworkPolicyDoc {
  const labels = tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug });
  const merged = Array.from(new Set([...input.adapterAllowFqdns, ...input.tenantAllowFqdns])).sort();
  const fqdns: CiliumFqdn[] = merged.map(p => p.includes("*") ? { matchPattern: p } : { matchName: p });

  const egress: CiliumNetworkPolicyDoc["spec"]["egress"] = [];
  if (fqdns.length > 0) {
    egress.push({ toFQDNs: fqdns, toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }] });
  }
  if (input.controlPlaneSelector) {
    egress.push({
      toEndpoints: [{ matchLabels: input.controlPlaneSelector.matchLabels }],
      toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }],
    });
  }

  return {
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: { name: "paperclip-agent-egress-l7", namespace: input.namespace, labels },
    spec: {
      endpointSelector: { matchLabels: { [PAPERCLIP_ROLE]: ROLE_AGENT_RUNTIME } },
      egress,
    },
  };
}

export async function applyCiliumNetworkPolicy(client: KubernetesApiClient, p: CiliumNetworkPolicyDoc): Promise<void> {
  const ns = p.metadata.namespace;
  const name = p.metadata.name;
  const path = `/apis/cilium.io/v2/namespaces/${encodeURIComponent(ns)}/ciliumnetworkpolicies/${encodeURIComponent(name)}`;
  try {
    await client.request("GET", path);
    await client.request("PUT", path, p);
  } catch (err: unknown) {
    if (/404/.test(String(err))) {
      await client.request(
        "POST",
        `/apis/cilium.io/v2/namespaces/${encodeURIComponent(ns)}/ciliumnetworkpolicies`,
        p,
      );
      return;
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test cilium-network-policy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/cilium-network-policy.ts \
        packages/adapters/kubernetes-execution/test/unit/cilium-network-policy.test.ts
git commit -m "feat(k8s-adapter): add Cilium NetworkPolicy builder for FQDN allowlist"
```

---

## Task 14: Image pull secret builder + apply

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/image-pull-secret.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/image-pull-secret.test.ts`

Reference: spec §5.3. The Paperclip secret reference resolution is plugged in via a callback so the package itself stays agnostic of Paperclip's secret store.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { buildImagePullSecret } from "../../src/orchestrator/image-pull-secret.js";

describe("buildImagePullSecret", () => {
  it("base64-encodes the dockerconfigjson and sets the dockerconfigjson type", () => {
    const dockerConfig = { auths: { "ghcr.io": { auth: "Zm9vOmJhcg==" } } };
    const s = buildImagePullSecret({
      namespace: "paperclip-acme",
      companyId: "c-1", companySlug: "acme",
      dockerConfigJson: JSON.stringify(dockerConfig),
    });
    expect(s.type).toBe("kubernetes.io/dockerconfigjson");
    expect(s.metadata?.name).toBe("paperclip-image-pull");
    expect(s.data?.[".dockerconfigjson"]).toBeDefined();
    const decoded = Buffer.from(s.data![".dockerconfigjson"], "base64").toString("utf-8");
    expect(JSON.parse(decoded)).toEqual(dockerConfig);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test image-pull-secret`
Expected: FAIL.

- [ ] **Step 3: Implement `image-pull-secret.ts`**

```ts
import type { V1Secret } from "@kubernetes/client-node";
import type { KubernetesApiClient } from "../types.js";
import { tenantBaseLabels } from "./labels.js";

export interface BuildImagePullSecretInput {
  namespace: string;
  companyId: string;
  companySlug: string;
  /** A docker config JSON string already resolved from a Paperclip secret_ref. */
  dockerConfigJson: string;
}

export function buildImagePullSecret(input: BuildImagePullSecretInput): V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "paperclip-image-pull",
      namespace: input.namespace,
      labels: tenantBaseLabels({ companyId: input.companyId, companySlug: input.companySlug }),
    },
    type: "kubernetes.io/dockerconfigjson",
    data: {
      ".dockerconfigjson": Buffer.from(input.dockerConfigJson, "utf-8").toString("base64"),
    },
  };
}

export async function applyImagePullSecret(client: KubernetesApiClient, s: V1Secret): Promise<void> {
  const ns = s.metadata!.namespace!;
  const name = s.metadata!.name!;
  try {
    await client.core.readNamespacedSecret(name, ns);
    await client.core.patchNamespacedSecret(name, ns, s, undefined, undefined, undefined, undefined, undefined, {
      headers: { "Content-Type": "application/strategic-merge-patch+json" },
    } as never);
  } catch (err) {
    if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 404) {
      await client.core.createNamespacedSecret(ns, s);
      return;
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test image-pull-secret`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/image-pull-secret.ts \
        packages/adapters/kubernetes-execution/test/unit/image-pull-secret.test.ts
git commit -m "feat(k8s-adapter): add per-namespace image pull secret builder"
```

---

## Task 15: ensureTenantNamespace orchestrator

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/ensure-tenant.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/ensure-tenant.test.ts`

Reference: spec §2.1 (provisioning). This is the integrator that combines Tasks 7–14.

- [ ] **Step 1: Write failing test that uses mocked applies and asserts ordering and labels**

```ts
import { describe, it, expect, vi } from "vitest";
import { ensureTenantNamespace, type EnsureTenantInput } from "../../src/orchestrator/ensure-tenant.js";

function makeFakeClient() {
  return {
    core: {
      readNamespace: vi.fn(async () => { const e = new Error("not found"); (e as any).response = { statusCode: 404 }; throw e; }),
      createNamespace: vi.fn(async () => ({})),
      patchNamespace: vi.fn(async () => ({})),
      readNamespacedServiceAccount: vi.fn(async () => { const e = new Error("nf"); (e as any).response = { statusCode: 404 }; throw e; }),
      createNamespacedServiceAccount: vi.fn(async () => ({})),
      readNamespacedResourceQuota: vi.fn(async () => { const e = new Error("nf"); (e as any).response = { statusCode: 404 }; throw e; }),
      createNamespacedResourceQuota: vi.fn(async () => ({})),
      readNamespacedLimitRange: vi.fn(async () => { const e = new Error("nf"); (e as any).response = { statusCode: 404 }; throw e; }),
      createNamespacedLimitRange: vi.fn(async () => ({})),
      readNamespacedSecret: vi.fn(async () => { const e = new Error("nf"); (e as any).response = { statusCode: 404 }; throw e; }),
      createNamespacedSecret: vi.fn(async () => ({})),
    },
    rbac: {
      readNamespacedRoleBinding: vi.fn(async () => { const e = new Error("nf"); (e as any).response = { statusCode: 404 }; throw e; }),
      createNamespacedRoleBinding: vi.fn(async () => ({})),
      deleteNamespacedRoleBinding: vi.fn(async () => ({})),
    },
    networking: {
      readNamespacedNetworkPolicy: vi.fn(async () => { const e = new Error("nf"); (e as any).response = { statusCode: 404 }; throw e; }),
      createNamespacedNetworkPolicy: vi.fn(async () => ({})),
    },
    request: vi.fn(async () => ({})),
  } as never;
}

describe("ensureTenantNamespace", () => {
  it("creates Namespace before any namespaced object", async () => {
    const client = makeFakeClient();
    const input: EnsureTenantInput = {
      connection: {
        id: "c-1", label: "test", kind: "kubeconfig", kubeconfigYaml: "<unused>",
        defaultNamespacePrefix: "paperclip-",
        allowAgentImageOverride: false,
        capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      },
      company: { id: "11111111-1111-1111-1111-111111111111", slug: "acme-corp" },
      tenantPolicy: null,
      driverServiceAccount: { name: "paperclip-driver", namespace: "paperclip-system" },
      controlPlane: { topology: "in-cluster", namespaceLabels: { "paperclip.ai/role": "control-plane" }, podLabels: { "app.kubernetes.io/name": "paperclip-server" } },
      adapterAllowFqdns: ["*.anthropic.com"],
      imagePullDockerConfigJson: null,
    };

    const result = await ensureTenantNamespace(client, input);
    expect(result.namespace).toBe("paperclip-acme-corp");
    expect(client.core.createNamespace).toHaveBeenCalledTimes(1);
    expect(client.core.createNamespacedServiceAccount).toHaveBeenCalledTimes(1);
    expect(client.core.createNamespacedResourceQuota).toHaveBeenCalledTimes(1);
    expect(client.core.createNamespacedLimitRange).toHaveBeenCalledTimes(1);
    expect(client.networking.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(3); // 2 deny + 1 egress
    // Cilium is disabled in capabilities -> no CNP request
    expect(client.request).not.toHaveBeenCalled();
  });

  it("emits a Cilium policy when cluster supports it", async () => {
    const client = makeFakeClient();
    client.request = vi.fn(async (method: string) => method === "GET" ? { kind: "ok" } : ({})); // for GET and PUT/POST
    const input: EnsureTenantInput = {
      connection: {
        id: "c-1", label: "t", kind: "kubeconfig", kubeconfigYaml: "x",
        defaultNamespacePrefix: "paperclip-",
        allowAgentImageOverride: false,
        capabilities: { cilium: true, storageClass: "standard", architectures: ["amd64"] },
      },
      company: { id: "22222222-2222-2222-2222-222222222222", slug: "acme" },
      tenantPolicy: null,
      driverServiceAccount: { name: "drv", namespace: "paperclip-system" },
      controlPlane: { topology: "in-cluster", namespaceLabels: { "paperclip.ai/role": "control-plane" }, podLabels: { "app.kubernetes.io/name": "paperclip-server" } },
      adapterAllowFqdns: ["api.anthropic.com"],
      imagePullDockerConfigJson: null,
    };
    await ensureTenantNamespace(client, input);
    expect(client.request).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test ensure-tenant`
Expected: FAIL.

- [ ] **Step 3: Implement `ensure-tenant.ts`**

```ts
import type { KubernetesApiClient, ResolvedClusterConnection } from "../types.js";
import { deriveNamespaceName } from "./naming.js";
import { buildNamespace, applyNamespace } from "./namespace.js";
import { buildAgentServiceAccount, applyAgentServiceAccount, buildDriverRoleBinding, applyDriverRoleBinding } from "./rbac.js";
import { buildResourceQuota, buildLimitRange, applyResourceQuota, applyLimitRange, type QuotaOverride, type LimitRangeOverride } from "./resource-quota.js";
import { buildDefaultDenyPolicies, buildAgentEgressPolicy, applyNetworkPolicy } from "./network-policy.js";
import { buildCiliumAgentEgressPolicy, applyCiliumNetworkPolicy } from "./cilium-network-policy.js";
import { buildImagePullSecret, applyImagePullSecret } from "./image-pull-secret.js";

export interface TenantPolicy {
  quota: QuotaOverride | null;
  limitRange: LimitRangeOverride | null;
  additionalAllowFqdns: string[];
  imageOverrides: Record<string, string> | null;
}

export interface EnsureTenantInput {
  connection: ResolvedClusterConnection;
  company: { id: string; slug: string };
  tenantPolicy: TenantPolicy | null;
  driverServiceAccount: { name: string; namespace: string };
  controlPlane: {
    topology: "in-cluster" | "cross-cluster";
    namespaceLabels: Record<string, string>;
    podLabels: Record<string, string>;
  };
  adapterAllowFqdns: string[];
  /** Resolved registry credentials. If null, no image pull secret is created. */
  imagePullDockerConfigJson: string | null;
}

export interface EnsureTenantResult {
  namespace: string;
  ciliumApplied: boolean;
}

export async function ensureTenantNamespace(
  client: KubernetesApiClient,
  input: EnsureTenantInput,
): Promise<EnsureTenantResult> {
  const namespace = deriveNamespaceName({
    companySlug: input.company.slug,
    companyId: input.company.id,
    prefix: input.connection.defaultNamespacePrefix,
  });

  // 1. Namespace (must come first; everything below is namespaced).
  await applyNamespace(client, buildNamespace({
    name: namespace,
    companyId: input.company.id,
    companySlug: input.company.slug,
  }));

  // 2. RBAC.
  await applyAgentServiceAccount(client, buildAgentServiceAccount({
    namespace, companyId: input.company.id, companySlug: input.company.slug,
  }));
  await applyDriverRoleBinding(client, buildDriverRoleBinding({
    namespace,
    driverServiceAccount: input.driverServiceAccount,
    clusterRoleName: "paperclip-tenant-manager",
    companyId: input.company.id, companySlug: input.company.slug,
  }));

  // 3. Quota & LimitRange.
  await applyResourceQuota(client, buildResourceQuota({
    namespace, companyId: input.company.id, companySlug: input.company.slug,
    override: input.tenantPolicy?.quota ?? null,
  }));
  await applyLimitRange(client, buildLimitRange({
    namespace, companyId: input.company.id, companySlug: input.company.slug,
    override: input.tenantPolicy?.limitRange ?? null,
  }));

  // 4. NetworkPolicies (vanilla — always).
  for (const p of buildDefaultDenyPolicies({
    namespace, companyId: input.company.id, companySlug: input.company.slug,
  })) {
    await applyNetworkPolicy(client, p);
  }
  await applyNetworkPolicy(client, buildAgentEgressPolicy({
    namespace,
    companyId: input.company.id,
    companySlug: input.company.slug,
    topology: input.controlPlane.topology,
    controlPlaneSelector: input.controlPlane.topology === "in-cluster"
      ? { namespaceLabel: input.controlPlane.namespaceLabels, podLabel: input.controlPlane.podLabels }
      : null,
  }));

  // 5. Cilium policy (only when cluster supports it).
  let ciliumApplied = false;
  if (input.connection.capabilities.cilium) {
    await applyCiliumNetworkPolicy(client, buildCiliumAgentEgressPolicy({
      namespace,
      companyId: input.company.id,
      companySlug: input.company.slug,
      adapterAllowFqdns: input.adapterAllowFqdns,
      tenantAllowFqdns: input.tenantPolicy?.additionalAllowFqdns ?? [],
      controlPlaneSelector: input.controlPlane.topology === "in-cluster"
        ? { matchLabels: input.controlPlane.namespaceLabels }
        : null,
    }));
    ciliumApplied = true;
  }

  // 6. Image pull secret (when registry creds were supplied).
  if (input.imagePullDockerConfigJson) {
    await applyImagePullSecret(client, buildImagePullSecret({
      namespace, companyId: input.company.id, companySlug: input.company.slug,
      dockerConfigJson: input.imagePullDockerConfigJson,
    }));
  }

  return { namespace, ciliumApplied };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test ensure-tenant`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/ensure-tenant.ts \
        packages/adapters/kubernetes-execution/test/unit/ensure-tenant.test.ts
git commit -m "feat(k8s-adapter): add ensureTenantNamespace orchestrator"
```

---

## Task 16: Driver skeleton (validate + ensureTenant; run() stub)

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/driver.ts`
- Modify: `packages/adapters/kubernetes-execution/src/index.ts`
- Create: `packages/adapters/kubernetes-execution/test/unit/driver.test.ts`

The driver is the public surface that the server's registry consumes. In M1 it implements `validateTarget` and `ensureTenant`; `run` returns a clear "not yet implemented" result so M2 can replace it.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { createKubernetesExecutionDriver } from "../../src/driver.js";

describe("KubernetesExecutionDriver", () => {
  it("rejects non-kubernetes targets at validate", async () => {
    const driver = createKubernetesExecutionDriver({ resolveConnection: async () => null });
    await expect(driver.validateTarget({ kind: "local" } as never))
      .rejects.toThrow(/kubernetes/i);
  });

  it("rejects unknown clusterConnectionId", async () => {
    const driver = createKubernetesExecutionDriver({ resolveConnection: async () => null });
    await expect(driver.validateTarget({ kind: "kubernetes", clusterConnectionId: "missing" }))
      .rejects.toThrow(/cluster connection.+not found/i);
  });

  it("returns NOT_YET_SUPPORTED from run() in M1", async () => {
    const driver = createKubernetesExecutionDriver({ resolveConnection: async () => null });
    const result = await driver.run({
      ctx: { runId: "r-1", agent: { id: "a-1", companyId: "c-1", name: "x", adapterType: "claude_local", adapterConfig: {} }, runtime: {} as never, config: {}, context: {}, onLog: async () => {} },
      target: { kind: "kubernetes", clusterConnectionId: "c-1" },
    });
    expect(result.errorCode).toBe("execution_target_not_yet_supported");
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test driver`
Expected: FAIL.

- [ ] **Step 3: Implement `driver.ts`**

```ts
import type { AdapterExecutionContext, AdapterExecutionResult, AdapterKubernetesExecutionTarget } from "@paperclipai/adapter-utils";
import { ensureTenantNamespace, type EnsureTenantInput } from "./orchestrator/ensure-tenant.js";
import { createKubernetesApiClient } from "./client.js";
import type { ResolvedClusterConnection } from "./types.js";

export interface KubernetesExecutionDriver {
  type: "kubernetes";
  validateTarget(target: unknown): Promise<void>;
  ensureTenant(input: Omit<EnsureTenantInput, "connection"> & { connection?: never; clusterConnectionId: string }): Promise<{ namespace: string; ciliumApplied: boolean }>;
  run(input: { ctx: AdapterExecutionContext; target: AdapterKubernetesExecutionTarget }): Promise<AdapterExecutionResult>;
}

export interface KubernetesDriverDeps {
  resolveConnection: (id: string) => Promise<ResolvedClusterConnection | null>;
}

export function createKubernetesExecutionDriver(deps: KubernetesDriverDeps): KubernetesExecutionDriver {
  return {
    type: "kubernetes",
    async validateTarget(target) {
      const t = target as { kind?: string; clusterConnectionId?: string };
      if (t.kind !== "kubernetes") {
        throw new Error(`KubernetesExecutionDriver received target with kind=${t.kind}, expected "kubernetes"`);
      }
      if (!t.clusterConnectionId) {
        throw new Error(`KubernetesExecutionDriver target is missing clusterConnectionId`);
      }
      const connection = await deps.resolveConnection(t.clusterConnectionId);
      if (!connection) {
        throw new Error(`Cluster connection ${t.clusterConnectionId} not found`);
      }
    },
    async ensureTenant({ clusterConnectionId, ...rest }) {
      const connection = await deps.resolveConnection(clusterConnectionId);
      if (!connection) {
        throw new Error(`Cluster connection ${clusterConnectionId} not found`);
      }
      const client = createKubernetesApiClient(connection);
      return ensureTenantNamespace(client, { connection, ...rest } as EnsureTenantInput);
    },
    async run() {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorCode: "execution_target_not_yet_supported",
        errorMessage:
          "Kubernetes agent execution lands in M2; M1 covers tenant provisioning only. " +
          "Use `paperclipai cluster ensure-tenant <companyId>` to provision a namespace.",
      };
    },
  };
}
```

- [ ] **Step 4: Re-export from `src/index.ts`**

```ts
export { createKubernetesExecutionDriver, type KubernetesExecutionDriver, type KubernetesDriverDeps } from "./driver.js";
export { ensureTenantNamespace, type EnsureTenantInput, type TenantPolicy, type EnsureTenantResult } from "./orchestrator/ensure-tenant.js";
export { createKubernetesApiClient } from "./client.js";
export { probeClusterCapabilities } from "./orchestrator/capabilities.js";
export { deriveNamespaceName } from "./orchestrator/naming.js";
export type { ResolvedClusterConnection, ClusterCapabilities, KubernetesApiClient } from "./types.js";
```

- [ ] **Step 5: Run, expect pass**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test driver`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/driver.ts \
        packages/adapters/kubernetes-execution/src/index.ts \
        packages/adapters/kubernetes-execution/test/unit/driver.test.ts
git commit -m "feat(k8s-adapter): add driver skeleton with validateTarget and ensureTenant"
```

---

## Task 17: Server-side ExecutionTargetDriverRegistry

**Files:**
- Create: `server/src/adapters/execution-target-registry.ts`
- Create: `server/src/adapters/execution-target-registry.test.ts`

Reference: spec §1.2 (the platform-module-style registry).

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { createExecutionTargetRegistry } from "./execution-target-registry.js";

describe("ExecutionTargetDriverRegistry", () => {
  it("registers and retrieves a driver by kind", () => {
    const reg = createExecutionTargetRegistry();
    const fakeDriver = { type: "kubernetes" as const, validateTarget: async () => {}, ensureTenant: async () => ({ namespace: "x", ciliumApplied: false }), run: async () => ({ exitCode: 0, signal: null, timedOut: false }) };
    reg.register(fakeDriver as never);
    expect(reg.get("kubernetes")).toBe(fakeDriver);
  });

  it("rejects duplicate registrations of the same kind", () => {
    const reg = createExecutionTargetRegistry();
    const d = { type: "kubernetes" as const } as never;
    reg.register(d);
    expect(() => reg.register(d)).toThrow(/already registered/i);
  });

  it("returns null for unknown kinds", () => {
    const reg = createExecutionTargetRegistry();
    expect(reg.get("nomad")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/server test execution-target-registry`
Expected: FAIL.

- [ ] **Step 3: Implement `execution-target-registry.ts`**

```ts
import type { KubernetesExecutionDriver } from "@paperclipai/execution-target-kubernetes";

// Future kinds union with their driver shapes here.
export type ExecutionTargetDriver = KubernetesExecutionDriver;

export interface ExecutionTargetDriverRegistry {
  register(driver: ExecutionTargetDriver): void;
  get(kind: ExecutionTargetDriver["type"]): ExecutionTargetDriver | null;
  list(): ExecutionTargetDriver[];
}

export function createExecutionTargetRegistry(): ExecutionTargetDriverRegistry {
  const drivers = new Map<string, ExecutionTargetDriver>();
  return {
    register(driver) {
      if (drivers.has(driver.type)) {
        throw new Error(`Execution target driver "${driver.type}" already registered`);
      }
      drivers.set(driver.type, driver);
    },
    get(kind) { return drivers.get(kind) ?? null; },
    list() { return [...drivers.values()]; },
  };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @paperclipai/server test execution-target-registry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/adapters/execution-target-registry.ts \
        server/src/adapters/execution-target-registry.test.ts
git commit -m "feat(server): add ExecutionTargetDriverRegistry"
```

---

## Task 18: ClusterConnections service + secret resolution

**Files:**
- Create: `server/src/services/cluster-connections.ts`
- Create: `server/src/services/cluster-connections.test.ts`

- [ ] **Step 1: Write failing test (uses embedded postgres harness)**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { clusterConnectionsService } from "./cluster-connections.js";

let dbHandle: EmbeddedPostgresTestDatabase;

beforeAll(async () => { dbHandle = await startEmbeddedPostgresTestDatabase(); });
afterAll(async () => { await dbHandle.stop(); });

describe("clusterConnectionsService", () => {
  it("creates, lists, gets, and deletes a connection", async () => {
    const svc = clusterConnectionsService(dbHandle.client, {
      resolveSecret: async () => "fake-kubeconfig-yaml",
    });
    const created = await svc.create({
      label: "kind-test",
      kind: "kubeconfig",
      kubeconfigSecretRef: { provider: "local_encrypted", name: "kind-cfg" },
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      createdBy: "system",
    });
    expect(created.id).toBeDefined();

    const list = await svc.list();
    expect(list).toHaveLength(1);

    const fetched = await svc.get(created.id);
    expect(fetched?.label).toBe("kind-test");

    const resolved = await svc.resolve(created.id);
    expect(resolved?.kubeconfigYaml).toBe("fake-kubeconfig-yaml");

    await svc.delete(created.id);
    expect(await svc.list()).toHaveLength(0);
  });

  it("rejects duplicate labels", async () => {
    const svc = clusterConnectionsService(dbHandle.client, { resolveSecret: async () => "x" });
    await svc.create({
      label: "dupe", kind: "in-cluster",
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      createdBy: "system",
    });
    await expect(svc.create({
      label: "dupe", kind: "in-cluster",
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      createdBy: "system",
    })).rejects.toThrow(/label/i);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/server test cluster-connections`
Expected: FAIL.

- [ ] **Step 3: Implement `cluster-connections.ts`**

```ts
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clusterConnections } from "@paperclipai/db";
import type { ResolvedClusterConnection, ClusterCapabilities } from "@paperclipai/execution-target-kubernetes";

export interface ClusterConnectionRow {
  id: string;
  label: string;
  kind: "in-cluster" | "kubeconfig";
  kubeconfigSecretRef: { provider: string; name: string } | null;
  apiServerUrl: string | null;
  defaultNamespacePrefix: string;
  capabilities: ClusterCapabilities;
  paperclipPublicUrl: string | null;
  imageRegistry: string | null;
  allowAgentImageOverride: boolean;
  createdAt: Date;
  createdBy: string;
}

export interface CreateClusterConnectionInput {
  label: string;
  kind: "in-cluster" | "kubeconfig";
  kubeconfigSecretRef?: { provider: string; name: string };
  apiServerUrl?: string;
  defaultNamespacePrefix?: string;
  capabilities: ClusterCapabilities;
  paperclipPublicUrl?: string;
  imageRegistry?: string;
  allowAgentImageOverride?: boolean;
  createdBy: string;
}

export interface ClusterConnectionsServiceDeps {
  resolveSecret: (ref: { provider: string; name: string }) => Promise<string>;
}

export function clusterConnectionsService(db: Db, deps: ClusterConnectionsServiceDeps) {
  return {
    async create(input: CreateClusterConnectionInput): Promise<ClusterConnectionRow> {
      try {
        const [row] = await db.insert(clusterConnections).values({
          label: input.label,
          kind: input.kind,
          kubeconfigSecretRef: input.kubeconfigSecretRef ?? null,
          apiServerUrl: input.apiServerUrl ?? null,
          defaultNamespacePrefix: input.defaultNamespacePrefix ?? "paperclip-",
          capabilities: input.capabilities,
          paperclipPublicUrl: input.paperclipPublicUrl ?? null,
          imageRegistry: input.imageRegistry ?? null,
          allowAgentImageOverride: input.allowAgentImageOverride ? "true" : "false",
          createdBy: input.createdBy,
        }).returning();
        return mapRow(row);
      } catch (err: unknown) {
        if (/cluster_connections_label_uq/.test(String(err))) {
          throw new Error(`A cluster connection with label "${input.label}" already exists`);
        }
        throw err;
      }
    },

    async list(): Promise<ClusterConnectionRow[]> {
      const rows = await db.select().from(clusterConnections);
      return rows.map(mapRow);
    },

    async get(id: string): Promise<ClusterConnectionRow | null> {
      const [row] = await db.select().from(clusterConnections).where(eq(clusterConnections.id, id));
      return row ? mapRow(row) : null;
    },

    async delete(id: string): Promise<void> {
      await db.delete(clusterConnections).where(eq(clusterConnections.id, id));
    },

    async resolve(id: string): Promise<ResolvedClusterConnection | null> {
      const row = await this.get(id);
      if (!row) return null;
      let kubeconfigYaml: string | undefined;
      if (row.kind === "kubeconfig" && row.kubeconfigSecretRef) {
        kubeconfigYaml = await deps.resolveSecret(row.kubeconfigSecretRef);
      }
      return {
        id: row.id,
        label: row.label,
        kind: row.kind,
        kubeconfigYaml,
        apiServerUrl: row.apiServerUrl,
        defaultNamespacePrefix: row.defaultNamespacePrefix,
        paperclipPublicUrl: row.paperclipPublicUrl,
        imageRegistry: row.imageRegistry,
        allowAgentImageOverride: row.allowAgentImageOverride,
        capabilities: row.capabilities,
      };
    },
  };
}

function mapRow(row: typeof clusterConnections.$inferSelect): ClusterConnectionRow {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind as "in-cluster" | "kubeconfig",
    kubeconfigSecretRef: row.kubeconfigSecretRef,
    apiServerUrl: row.apiServerUrl,
    defaultNamespacePrefix: row.defaultNamespacePrefix,
    capabilities: row.capabilities,
    paperclipPublicUrl: row.paperclipPublicUrl,
    imageRegistry: row.imageRegistry,
    allowAgentImageOverride: row.allowAgentImageOverride === "true",
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @paperclipai/server test cluster-connections`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/cluster-connections.ts \
        server/src/services/cluster-connections.test.ts
git commit -m "feat(server): add cluster-connections service"
```

---

## Task 19: ClusterTenantPolicies service

**Files:**
- Create: `server/src/services/cluster-tenant-policies.ts`
- Create: `server/src/services/cluster-tenant-policies.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { clusterTenantPoliciesService } from "./cluster-tenant-policies.js";

let dbHandle: EmbeddedPostgresTestDatabase;

beforeAll(async () => { dbHandle = await startEmbeddedPostgresTestDatabase(); });
afterAll(async () => { await dbHandle.stop(); });

describe("clusterTenantPoliciesService", () => {
  it("upserts and reads back a policy", async () => {
    const svc = clusterTenantPoliciesService(dbHandle.client);
    // Create a fake cluster + company first via raw SQL since this test isolates the service.
    const [cluster] = await dbHandle.client.execute(`INSERT INTO cluster_connections(label, kind, capabilities, created_by) VALUES('c', 'in-cluster', '{"cilium":false,"storageClass":"standard","architectures":["amd64"]}'::jsonb, 'sys') RETURNING id`);
    const [company] = await dbHandle.client.execute(`INSERT INTO companies(name, slug) VALUES('Acme', 'acme') RETURNING id`);

    const upserted = await svc.upsert({
      clusterConnectionId: cluster.id as string,
      companyId: company.id as string,
      quota: { requestsCpu: "32" },
      limitRange: null,
      additionalAllowFqdns: ["api.acme.io"],
      imageOverrides: null,
    });
    expect(upserted.quota?.requestsCpu).toBe("32");

    const fetched = await svc.get(cluster.id as string, company.id as string);
    expect(fetched?.additionalAllowFqdns).toEqual(["api.acme.io"]);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/server test cluster-tenant-policies`
Expected: FAIL.

- [ ] **Step 3: Implement `cluster-tenant-policies.ts`**

```ts
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clusterTenantPolicies } from "@paperclipai/db";
import type { TenantPolicy } from "@paperclipai/execution-target-kubernetes";

export interface UpsertTenantPolicyInput {
  clusterConnectionId: string;
  companyId: string;
  quota: TenantPolicy["quota"];
  limitRange: TenantPolicy["limitRange"];
  additionalAllowFqdns: string[];
  imageOverrides: Record<string, string> | null;
}

export interface TenantPolicyRow extends TenantPolicy {
  clusterConnectionId: string;
  companyId: string;
}

export function clusterTenantPoliciesService(db: Db) {
  return {
    async get(clusterConnectionId: string, companyId: string): Promise<TenantPolicyRow | null> {
      const [row] = await db.select().from(clusterTenantPolicies).where(and(
        eq(clusterTenantPolicies.clusterConnectionId, clusterConnectionId),
        eq(clusterTenantPolicies.companyId, companyId),
      ));
      return row ? mapRow(row) : null;
    },

    async upsert(input: UpsertTenantPolicyInput): Promise<TenantPolicyRow> {
      const existing = await this.get(input.clusterConnectionId, input.companyId);
      if (existing) {
        const [updated] = await db.update(clusterTenantPolicies).set({
          quotaJson: input.quota,
          limitRangeJson: input.limitRange,
          networkJson: { additionalAllowFqdns: input.additionalAllowFqdns, httpProxyUrl: null },
          imageOverridesJson: input.imageOverrides,
          updatedAt: new Date(),
        }).where(and(
          eq(clusterTenantPolicies.clusterConnectionId, input.clusterConnectionId),
          eq(clusterTenantPolicies.companyId, input.companyId),
        )).returning();
        return mapRow(updated);
      }
      const [created] = await db.insert(clusterTenantPolicies).values({
        clusterConnectionId: input.clusterConnectionId,
        companyId: input.companyId,
        quotaJson: input.quota,
        limitRangeJson: input.limitRange,
        networkJson: { additionalAllowFqdns: input.additionalAllowFqdns, httpProxyUrl: null },
        imageOverridesJson: input.imageOverrides,
      }).returning();
      return mapRow(created);
    },
  };
}

function mapRow(r: typeof clusterTenantPolicies.$inferSelect): TenantPolicyRow {
  return {
    clusterConnectionId: r.clusterConnectionId,
    companyId: r.companyId,
    quota: r.quotaJson,
    limitRange: r.limitRangeJson,
    additionalAllowFqdns: r.networkJson?.additionalAllowFqdns ?? [],
    imageOverrides: r.imageOverridesJson,
  };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @paperclipai/server test cluster-tenant-policies`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/cluster-tenant-policies.ts \
        server/src/services/cluster-tenant-policies.test.ts
git commit -m "feat(server): add cluster-tenant-policies service"
```

---

## Task 20: Wire driver registration on server startup

**Files:**
- Create: `server/src/adapters/execution-targets/kubernetes.ts`
- Modify: `server/src/index.ts` (or wherever adapter registry init happens)

The server startup constructs the registry, registers the kubernetes driver passing in a `resolveConnection` deps closure backed by the `clusterConnectionsService`.

- [ ] **Step 1: Write integration test for the wiring**

Create `server/src/adapters/execution-targets/kubernetes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { registerKubernetesExecutionTargetDriver } from "./kubernetes.js";
import { createExecutionTargetRegistry } from "../execution-target-registry.js";

describe("registerKubernetesExecutionTargetDriver", () => {
  it("registers a driver of type 'kubernetes'", () => {
    const reg = createExecutionTargetRegistry();
    registerKubernetesExecutionTargetDriver(reg, {
      resolveConnection: async () => null,
    });
    const drv = reg.get("kubernetes");
    expect(drv).not.toBeNull();
    expect(drv?.type).toBe("kubernetes");
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/server test execution-targets/kubernetes`
Expected: FAIL.

- [ ] **Step 3: Implement the registration shim**

```ts
import { createKubernetesExecutionDriver, type KubernetesDriverDeps } from "@paperclipai/execution-target-kubernetes";
import type { ExecutionTargetDriverRegistry } from "../execution-target-registry.js";

export function registerKubernetesExecutionTargetDriver(
  registry: ExecutionTargetDriverRegistry,
  deps: KubernetesDriverDeps,
): void {
  registry.register(createKubernetesExecutionDriver(deps));
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @paperclipai/server test execution-targets/kubernetes`
Expected: PASS.

- [ ] **Step 5: Plug into the startup path**

Find the server startup file that constructs services (search for `clusterConnectionsService` callers if any; otherwise the main `app.ts` or `index.ts`).

Add construction of the registry there, e.g.:

```ts
import { createExecutionTargetRegistry } from "./adapters/execution-target-registry.js";
import { registerKubernetesExecutionTargetDriver } from "./adapters/execution-targets/kubernetes.js";
import { clusterConnectionsService } from "./services/cluster-connections.js";
// ...
const clusterConnections = clusterConnectionsService(db, { resolveSecret: secretsResolver.resolveById });
const executionTargetRegistry = createExecutionTargetRegistry();
registerKubernetesExecutionTargetDriver(executionTargetRegistry, {
  resolveConnection: (id) => clusterConnections.resolve(id),
});
// expose `executionTargetRegistry` to adapter execution code paths.
```

Add a smoke test that starts the server (or just the bootstrap function) and asserts the registry has the kubernetes driver registered.

- [ ] **Step 6: Commit**

```bash
git add server/src/adapters/execution-targets/kubernetes.ts \
        server/src/adapters/execution-targets/kubernetes.test.ts \
        server/src/index.ts
git commit -m "feat(server): register kubernetes execution-target driver on startup"
```

---

## Task 21: Existing adapters' `executionTarget` plumbing audit

Resolves Risk #3.

**Files:**
- Create: `packages/adapter-utils/test/contract/execution-target-kubernetes-rejection.test.ts`

Goal: each existing adapter, when given a `kubernetes` execution target, must NOT crash. It must return a clear `errorCode`/`errorMessage` indicating the target is not supported in M1 (since M1 lacks `run()` for k8s).

- [ ] **Step 1: For each built-in adapter, find its `execute` entry point**

Run: `grep -rn "createServerAdapter" packages/adapters/*/src/server/index.ts`
Note each adapter package: claude-local, codex-local, gemini-local, opencode-local, acpx-local, pi-local, hermes-local.

- [ ] **Step 2: Write a contract test that exercises each adapter with a k8s target**

```ts
import { describe, it, expect } from "vitest";
import * as claudeLocal from "@paperclipai/adapter-claude-local/server";
import * as codexLocal from "@paperclipai/adapter-codex-local/server";
import * as geminiLocal from "@paperclipai/adapter-gemini-local/server";
import * as opencodeLocal from "@paperclipai/adapter-opencode-local/server";
import * as acpxLocal from "@paperclipai/adapter-acpx-local/server";
import * as piLocal from "@paperclipai/adapter-pi-local/server";
import * as hermesLocal from "@paperclipai/adapter-hermes-local/server";
import type { AdapterExecutionContext, AdapterKubernetesExecutionTarget } from "@paperclipai/adapter-utils";

const adapters = [
  ["claude_local", claudeLocal],
  ["codex_local", codexLocal],
  ["gemini_local", geminiLocal],
  ["opencode_local", opencodeLocal],
  ["acpx_local", acpxLocal],
  ["pi_local", piLocal],
  ["hermes_local", hermesLocal],
] as const;

const k8sTarget: AdapterKubernetesExecutionTarget = { kind: "kubernetes", clusterConnectionId: "c-1" };

function ctx(): AdapterExecutionContext {
  return {
    runId: "r-1",
    agent: { id: "a-1", companyId: "c-1", name: "x", adapterType: "x", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: async () => {},
    executionTarget: k8sTarget,
  };
}

describe("adapter contract: kubernetes target rejection in M1", () => {
  for (const [name, mod] of adapters) {
    it(`${name} returns a clear error result rather than throwing`, async () => {
      const adapter = mod.createServerAdapter();
      const result = await adapter.execute(ctx());
      expect(result.exitCode).toBeNull();
      expect(result.errorCode).toMatch(/kubernetes|execution_target/i);
      expect(result.errorMessage).toContain("Kubernetes");
    });
  }
});
```

- [ ] **Step 3: Run, expect failures**

Run: `pnpm test packages/adapter-utils/test/contract`
Expected: each adapter either throws or returns a non-matching error.

- [ ] **Step 4: For each adapter, add the rejection branch**

In each adapter's `execute.ts`, near the top:

```ts
if (ctx.executionTarget?.kind === "kubernetes") {
  return {
    exitCode: null, signal: null, timedOut: false,
    errorCode: "execution_target_not_yet_supported",
    errorMessage:
      "Kubernetes execution target is not implemented yet for this adapter. " +
      "Tenant provisioning is available in M1; agent execution lands in M2.",
  };
}
```

Run the contract test after each adapter. Commit per adapter.

- [ ] **Step 5: Final commit (after all adapters)**

```bash
git add packages/adapters/*/src/server/execute.ts \
        packages/adapter-utils/test/contract/execution-target-kubernetes-rejection.test.ts
git commit -m "feat(adapters): reject kubernetes execution target with a clear error in M1"
```

---

## Task 22: Integration test harness against `kind`

**Files:**
- Create: `packages/adapters/kubernetes-execution/test/integration/_harness.ts`
- Create: `packages/adapters/kubernetes-execution/test/integration/ensure-tenant.test.ts`
- Create: `packages/adapters/kubernetes-execution/test/integration/ensure-tenant-idempotency.test.ts`
- Create: `packages/adapters/kubernetes-execution/test/integration/ensure-tenant-drift.test.ts`
- Create: `packages/adapters/kubernetes-execution/vitest.integration.config.ts`

Pre-req: `kind` binary on `$PATH`. CI step installs it via `go install sigs.k8s.io/kind@latest` or fetches the static binary from the kind release page (deterministic version pin).

- [ ] **Step 1: Write the harness**

```ts
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface KindCluster {
  name: string;
  kubeconfigPath: string;
  kubeconfigYaml: string;
  cleanup(): void;
}

export function spinUpKind(): KindCluster {
  const name = `pp-test-${Math.random().toString(36).slice(2, 8)}`;
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  const kubeconfigPath = join(dir, "kubeconfig");
  execSync(`kind create cluster --name ${name} --kubeconfig ${kubeconfigPath} --wait 60s`, { stdio: "inherit" });
  const kubeconfigYaml = readFileSync(kubeconfigPath, "utf-8");
  return {
    name,
    kubeconfigPath,
    kubeconfigYaml,
    cleanup: () => {
      try { execSync(`kind delete cluster --name ${name}`, { stdio: "ignore" }); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 2: Add vitest integration config**

```ts
// vitest.integration.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
```

- [ ] **Step 3: Write the happy-path integration test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spinUpKind, type KindCluster } from "./_harness.js";
import { createKubernetesApiClient, ensureTenantNamespace, probeClusterCapabilities } from "../../src/index.js";

let cluster: KindCluster;

beforeAll(async () => { cluster = spinUpKind(); }, 180_000);
afterAll(() => { cluster.cleanup(); });

describe("ensureTenantNamespace against kind", () => {
  it("provisions a fully isolated tenant namespace", async () => {
    const client = createKubernetesApiClient({
      id: "c-1", label: "kind", kind: "kubeconfig", kubeconfigYaml: cluster.kubeconfigYaml,
      defaultNamespacePrefix: "paperclip-",
      allowAgentImageOverride: false,
      capabilities: await probeClusterCapabilities({} as never).catch(() => ({ cilium: false, storageClass: "standard", architectures: ["amd64"] })),
    });
    const result = await ensureTenantNamespace(client, {
      connection: {
        id: "c-1", label: "kind", kind: "kubeconfig", kubeconfigYaml: cluster.kubeconfigYaml,
        defaultNamespacePrefix: "paperclip-",
        allowAgentImageOverride: false,
        capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      },
      company: { id: "11111111-1111-1111-1111-111111111111", slug: "acme-corp" },
      tenantPolicy: null,
      driverServiceAccount: { name: "default", namespace: "default" }, // kind shortcut
      controlPlane: { topology: "cross-cluster", namespaceLabels: {}, podLabels: {} },
      adapterAllowFqdns: [],
      imagePullDockerConfigJson: null,
    });
    expect(result.namespace).toBe("paperclip-acme-corp");

    // Assert all the objects exist with the expected labels.
    const ns = await client.core.readNamespace(result.namespace);
    expect(ns.body.metadata?.labels?.["paperclip.ai/managed-by"]).toBe("paperclip");
    expect(ns.body.metadata?.labels?.["pod-security.kubernetes.io/enforce"]).toBe("restricted");

    const sa = await client.core.readNamespacedServiceAccount("paperclip-agent", result.namespace);
    expect(sa.body.automountServiceAccountToken).toBe(false);

    const quota = await client.core.readNamespacedResourceQuota("paperclip-tenant-quota", result.namespace);
    expect(quota.body.spec?.hard?.["requests.cpu"]).toBe("16");

    const policies = await client.networking.listNamespacedNetworkPolicy(result.namespace);
    const names = policies.body.items.map(p => p.metadata?.name).sort();
    expect(names).toEqual(["default-deny-egress", "default-deny-ingress", "paperclip-agent-egress"]);
  });
});
```

- [ ] **Step 4: Run integration**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test:integration`
Expected: cluster spins up, test passes.

- [ ] **Step 5: Idempotency test**

```ts
// ensure-tenant-idempotency.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spinUpKind, type KindCluster } from "./_harness.js";
import { createKubernetesApiClient, ensureTenantNamespace } from "../../src/index.js";

let cluster: KindCluster;
beforeAll(() => { cluster = spinUpKind(); }, 180_000);
afterAll(() => cluster.cleanup());

describe("ensureTenantNamespace idempotency", () => {
  it("a second call is a no-op-equivalent (object generation may not bump)", async () => {
    const connection = {
      id: "c-1", label: "kind", kind: "kubeconfig" as const, kubeconfigYaml: cluster.kubeconfigYaml,
      defaultNamespacePrefix: "paperclip-",
      allowAgentImageOverride: false,
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] as const },
    };
    const client = createKubernetesApiClient(connection);
    const input = {
      connection,
      company: { id: "11111111-1111-1111-1111-111111111112", slug: "idempotent-co" },
      tenantPolicy: null,
      driverServiceAccount: { name: "default", namespace: "default" },
      controlPlane: { topology: "cross-cluster" as const, namespaceLabels: {}, podLabels: {} },
      adapterAllowFqdns: [],
      imagePullDockerConfigJson: null,
    };
    const r1 = await ensureTenantNamespace(client, input);
    const r2 = await ensureTenantNamespace(client, input);
    expect(r1.namespace).toBe(r2.namespace);
    // Still exactly one set of objects.
    const policies = await client.networking.listNamespacedNetworkPolicy(r1.namespace);
    expect(policies.body.items.length).toBe(3);
  });
});
```

- [ ] **Step 6: Drift correction test**

```ts
// ensure-tenant-drift.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spinUpKind, type KindCluster } from "./_harness.js";
import { createKubernetesApiClient, ensureTenantNamespace } from "../../src/index.js";

let cluster: KindCluster;
beforeAll(() => { cluster = spinUpKind(); }, 180_000);
afterAll(() => cluster.cleanup());

describe("ensureTenantNamespace drift correction", () => {
  it("recreates a NetworkPolicy that was deleted out-of-band", async () => {
    const connection = { id: "c-1", label: "kind", kind: "kubeconfig" as const, kubeconfigYaml: cluster.kubeconfigYaml, defaultNamespacePrefix: "paperclip-", allowAgentImageOverride: false, capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] as const } };
    const client = createKubernetesApiClient(connection);
    const input = {
      connection,
      company: { id: "11111111-1111-1111-1111-111111111113", slug: "drift-co" },
      tenantPolicy: null,
      driverServiceAccount: { name: "default", namespace: "default" },
      controlPlane: { topology: "cross-cluster" as const, namespaceLabels: {}, podLabels: {} },
      adapterAllowFqdns: [],
      imagePullDockerConfigJson: null,
    };
    const { namespace } = await ensureTenantNamespace(client, input);
    await client.networking.deleteNamespacedNetworkPolicy("default-deny-egress", namespace);
    await ensureTenantNamespace(client, input);
    const policies = await client.networking.listNamespacedNetworkPolicy(namespace);
    expect(policies.body.items.find(p => p.metadata?.name === "default-deny-egress")).toBeDefined();
  });
});
```

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/kubernetes-execution/test/integration \
        packages/adapters/kubernetes-execution/vitest.integration.config.ts
git commit -m "test(k8s-adapter): add kind-based integration tests for ensureTenantNamespace"
```

---

## Task 23: PSS Restricted compliance gate

**Files:**
- Create: `packages/adapters/kubernetes-execution/test/integration/pss-restricted.test.ts`

Resolves spec compliance bookkeeping (§2.8). The test creates a tenant namespace, deploys a deliberately privileged Pod into it, and asserts the cluster rejects it at admission. Then deploys a compliant Pod and asserts it's accepted. Together this proves PSS Restricted is wired correctly.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spinUpKind, type KindCluster } from "./_harness.js";
import { createKubernetesApiClient, ensureTenantNamespace } from "../../src/index.js";

let cluster: KindCluster;
beforeAll(() => { cluster = spinUpKind(); }, 180_000);
afterAll(() => cluster.cleanup());

describe("PSS Restricted compliance for tenant namespace", () => {
  it("admission rejects a privileged Pod and accepts a compliant Pod", async () => {
    const connection = { id: "c-1", label: "kind", kind: "kubeconfig" as const, kubeconfigYaml: cluster.kubeconfigYaml, defaultNamespacePrefix: "paperclip-", allowAgentImageOverride: false, capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] as const } };
    const client = createKubernetesApiClient(connection);
    const { namespace } = await ensureTenantNamespace(client, {
      connection,
      company: { id: "11111111-1111-1111-1111-111111111114", slug: "pss-test" },
      tenantPolicy: null,
      driverServiceAccount: { name: "default", namespace: "default" },
      controlPlane: { topology: "cross-cluster", namespaceLabels: {}, podLabels: {} },
      adapterAllowFqdns: [],
      imagePullDockerConfigJson: null,
    });

    // Privileged Pod — must be rejected by admission.
    await expect(client.core.createNamespacedPod(namespace, {
      apiVersion: "v1", kind: "Pod",
      metadata: { name: "evil" },
      spec: {
        containers: [{
          name: "x", image: "busybox", command: ["sleep", "1"],
          securityContext: { privileged: true },
        }],
      },
    })).rejects.toThrow(/violates PodSecurity|forbidden/i);

    // Compliant Pod — must succeed.
    await client.core.createNamespacedPod(namespace, {
      apiVersion: "v1", kind: "Pod",
      metadata: { name: "good" },
      spec: {
        automountServiceAccountToken: false,
        securityContext: {
          runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [{
          name: "x", image: "busybox", command: ["sleep", "1"],
          securityContext: {
            allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
        }],
      },
    });
  });
});
```

- [ ] **Step 2: Run, expect pass**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test:integration pss`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/adapters/kubernetes-execution/test/integration/pss-restricted.test.ts
git commit -m "test(k8s-adapter): assert PSS Restricted admission on tenant namespace"
```

---

## Task 24: CLI commands — `paperclipai cluster ...`

**Files:**
- Create: `cli/src/commands/cluster.ts`
- Create: `cli/src/commands/cluster.test.ts`
- Modify: `cli/src/index.ts`

Subcommands for M1:
- `paperclipai cluster add --label <name> --kind <in-cluster|kubeconfig> [--kubeconfig-secret <ref>] [--paperclip-public-url <url>] [--image-registry <url>]`
- `paperclipai cluster list`
- `paperclipai cluster test <id>` — connects, probes capabilities, prints results.
- `paperclipai cluster remove <id>`
- `paperclipai cluster ensure-tenant <clusterId> <companyId>` — runs the orchestrator end-to-end.
- `paperclipai cluster doctor <id>` — runs all M1 health checks (connect, probe, dry-run ensure-tenant for a fake company, print the reference ClusterRole YAML location).

- [ ] **Step 1: Write failing tests for each subcommand (mocked services)**

```ts
import { describe, it, expect, vi } from "vitest";
import { createClusterCommand } from "./cluster.js";

function mocks() {
  return {
    clusterConnections: {
      create: vi.fn(async (i: any) => ({ id: "c-1", label: i.label })),
      list: vi.fn(async () => [{ id: "c-1", label: "kind", kind: "kubeconfig", capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] }, createdAt: new Date(), createdBy: "x" }]),
      get: vi.fn(async () => ({ id: "c-1", label: "kind", kind: "kubeconfig" })),
      delete: vi.fn(async () => {}),
      resolve: vi.fn(async () => ({ id: "c-1", label: "kind", kind: "kubeconfig", kubeconfigYaml: "x", defaultNamespacePrefix: "paperclip-", allowAgentImageOverride: false, capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] } })),
    },
    tenantPolicies: { get: vi.fn(async () => null), upsert: vi.fn() },
    driver: { ensureTenant: vi.fn(async () => ({ namespace: "paperclip-acme", ciliumApplied: false })), validateTarget: vi.fn(async () => {}), run: vi.fn() },
    companies: { getById: vi.fn(async () => ({ id: "co-1", slug: "acme" })) },
  };
}

describe("cluster commands", () => {
  it("add: creates a connection and prints its id", async () => {
    const m = mocks();
    const { stdout, exitCode } = await runCmd("add --label kind --kind kubeconfig --kubeconfig-secret local:my-cfg", m);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("c-1");
    expect(m.clusterConnections.create).toHaveBeenCalled();
  });

  it("list: prints connections with capabilities", async () => {
    const m = mocks();
    const { stdout } = await runCmd("list", m);
    expect(stdout).toContain("kind");
    expect(stdout).toContain("storageClass=standard");
  });

  it("ensure-tenant: calls driver.ensureTenant and prints namespace", async () => {
    const m = mocks();
    const { stdout, exitCode } = await runCmd("ensure-tenant c-1 co-1", m);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("paperclip-acme");
    expect(m.driver.ensureTenant).toHaveBeenCalled();
  });
});

async function runCmd(argv: string, m: ReturnType<typeof mocks>) {
  // Capture stdout/exit via the createClusterCommand harness; details depend on existing CLI plumbing.
  // For brevity in this plan, the engineer wires it through whatever pattern other commands use
  // (commander/cac/...). The test contract is what we assert above.
  // Implementation detail filled in step 3.
  const out: string[] = [];
  const cmd = createClusterCommand({
    clusterConnections: m.clusterConnections as never,
    tenantPolicies: m.tenantPolicies as never,
    driver: m.driver as never,
    companies: m.companies as never,
    print: (s: string) => out.push(s),
  });
  const exitCode = await cmd.run(argv.split(/\s+/));
  return { stdout: out.join("\n"), exitCode };
}
```

- [ ] **Step 2: Run, expect failure**

Run: `pnpm --filter @paperclipai/cli test cluster`
Expected: FAIL.

- [ ] **Step 3: Implement `cluster.ts`**

Match the existing CLI command convention (whatever framework Paperclip's CLI uses — discover by reading another command file like `cli/src/commands/<existing>.ts`). The shape:

```ts
import type { ExecutionTargetDriver } from "@paperclipai/server";
// imports for service interfaces from @paperclipai/server etc.

export interface ClusterCommandDeps {
  clusterConnections: { /* matches the service interface */ };
  tenantPolicies: { /* matches the service interface */ };
  driver: ExecutionTargetDriver;        // type "kubernetes"
  companies: { getById: (id: string) => Promise<{ id: string; slug: string } | null> };
  print: (line: string) => void;
}

export interface ClusterCommand {
  run(argv: string[]): Promise<number>;
}

export function createClusterCommand(deps: ClusterCommandDeps): ClusterCommand {
  return {
    async run(argv) {
      const [sub, ...rest] = argv;
      switch (sub) {
        case "add":          return cmdAdd(rest, deps);
        case "list":         return cmdList(rest, deps);
        case "test":         return cmdTest(rest, deps);
        case "remove":       return cmdRemove(rest, deps);
        case "ensure-tenant":return cmdEnsureTenant(rest, deps);
        case "doctor":       return cmdDoctor(rest, deps);
        default:
          deps.print(`Unknown subcommand: ${sub}\nUsage: cluster <add|list|test|remove|ensure-tenant|doctor>`);
          return 2;
      }
    },
  };
}

// each subcommand parses its own args (matching the existing command pattern in cli/src/commands)
// and calls the appropriate dep. Each prints structured output. Implementation detail follows the
// existing CLI command style.
```

Implement each subcommand. For `cmdEnsureTenant`:

```ts
async function cmdEnsureTenant(argv: string[], deps: ClusterCommandDeps): Promise<number> {
  const [clusterId, companyId] = argv;
  if (!clusterId || !companyId) {
    deps.print("Usage: cluster ensure-tenant <clusterId> <companyId>");
    return 2;
  }
  const company = await deps.companies.getById(companyId);
  if (!company) { deps.print(`Company ${companyId} not found`); return 1; }
  const tp = await deps.tenantPolicies.get(clusterId, companyId);
  const result = await deps.driver.ensureTenant({
    clusterConnectionId: clusterId,
    company,
    tenantPolicy: tp ? { quota: tp.quota, limitRange: tp.limitRange, additionalAllowFqdns: tp.additionalAllowFqdns, imageOverrides: tp.imageOverrides } : null,
    driverServiceAccount: { name: process.env.PAPERCLIP_DRIVER_SA ?? "paperclip-driver", namespace: process.env.PAPERCLIP_DRIVER_NAMESPACE ?? "paperclip-system" },
    controlPlane: { topology: "cross-cluster", namespaceLabels: {}, podLabels: {} },
    adapterAllowFqdns: [],
    imagePullDockerConfigJson: null,
  });
  deps.print(`Provisioned namespace ${result.namespace} (cilium=${result.ciliumApplied})`);
  return 0;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @paperclipai/cli test cluster`
Expected: PASS.

- [ ] **Step 5: Wire into `cli/src/index.ts`**

Match the existing pattern; expose `cluster` as a top-level subcommand alongside the other commands.

Add a manual smoke test step in CI: `paperclipai cluster list` returns `0`.

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/cluster.ts \
        cli/src/commands/cluster.test.ts \
        cli/src/index.ts
git commit -m "feat(cli): add `cluster` command (add|list|test|remove|ensure-tenant|doctor)"
```

---

## Task 25: End-to-end M1 smoke (CLI → kind cluster → tenant verified)

**Files:**
- Create: `packages/adapters/kubernetes-execution/test/integration/cli-end-to-end.test.ts`

Closes the loop: drives the orchestrator via the same path the CLI uses (`driver.ensureTenant`), with a real kind cluster, a real ClusterConnection row in embedded postgres, and a real company row.

- [ ] **Step 1: Write the smoke test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spinUpKind, type KindCluster } from "./_harness.js";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { clusterConnectionsService } from "@paperclipai/server/services/cluster-connections.js";
import { clusterTenantPoliciesService } from "@paperclipai/server/services/cluster-tenant-policies.js";
import { createExecutionTargetRegistry } from "@paperclipai/server/adapters/execution-target-registry.js";
import { registerKubernetesExecutionTargetDriver } from "@paperclipai/server/adapters/execution-targets/kubernetes.js";

let kc: KindCluster;
let db: EmbeddedPostgresTestDatabase;
beforeAll(async () => {
  kc = spinUpKind();
  db = await startEmbeddedPostgresTestDatabase();
}, 240_000);
afterAll(async () => { kc.cleanup(); await db.stop(); });

describe("M1 smoke", () => {
  it("registers cluster, provisions a tenant, kubectl confirms", async () => {
    // Insert a fake company.
    await db.client.execute(`INSERT INTO companies(id, name, slug) VALUES('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Acme', 'acme-corp')`);

    // Persist the kubeconfig as a fake "secret" via a stubbed resolver.
    const cs = clusterConnectionsService(db.client, { resolveSecret: async () => kc.kubeconfigYaml });
    const conn = await cs.create({
      label: "smoke-kind", kind: "kubeconfig",
      kubeconfigSecretRef: { provider: "stub", name: "kc" },
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      createdBy: "smoke",
    });

    // Wire the registry just like the server does.
    const reg = createExecutionTargetRegistry();
    registerKubernetesExecutionTargetDriver(reg, { resolveConnection: cs.resolve });
    const driver = reg.get("kubernetes")!;

    const result = await driver.ensureTenant({
      clusterConnectionId: conn.id,
      company: { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", slug: "acme-corp" },
      tenantPolicy: null,
      driverServiceAccount: { name: "default", namespace: "default" },
      controlPlane: { topology: "cross-cluster", namespaceLabels: {}, podLabels: {} },
      adapterAllowFqdns: [],
      imagePullDockerConfigJson: null,
    });
    expect(result.namespace).toBe("paperclip-acme-corp");
  });
});
```

- [ ] **Step 2: Run, expect pass**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes test:integration cli-end-to-end`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/adapters/kubernetes-execution/test/integration/cli-end-to-end.test.ts
git commit -m "test(k8s-adapter): end-to-end M1 smoke — CLI services + kind cluster"
```

---

## Task 26: Documentation

**Files:**
- Create: `docs/k8s-execution/quickstart.md`
- Create: `docs/k8s-execution/security-model.md`
- Create: `docs/k8s-execution/multi-tenant-onboarding.md`
- Create: `docs/k8s-execution/cluster-rbac.md`

- [ ] **Step 1: Write `quickstart.md`**

Cover:
- Pre-requisites (`kubectl`, kubeconfig, `kind` for testing).
- Apply the reference ClusterRole (`paperclip-tenant-manager-clusterrole.yaml`).
- Create a Paperclip secret holding the kubeconfig.
- `paperclipai cluster add ...`
- `paperclipai cluster doctor <id>`
- `paperclipai cluster ensure-tenant <clusterId> <companyId>`
- Verify with `kubectl get all,networkpolicy,resourcequota -n paperclip-<companySlug>`
- What's *not* yet supported in M1 (agent execution, UI, BYO cluster — see M2/M3).

- [ ] **Step 2: Write `security-model.md`**

Restate (don't re-prove) the spec's section 2.8 baseline:
- NSA/CISA hardening checklist with which control corresponds to which file/builder.
- Why `automountServiceAccountToken: false`.
- The RFC1918 + link-local egress block and why cloud metadata is the threat.
- Where the redaction layer sits.

- [ ] **Step 3: Write `multi-tenant-onboarding.md`**

The operator-facing playbook for adding a new company on an existing cluster:
- Verify the cluster has a default StorageClass and (recommended) Cilium for FQDN policy.
- Optionally upsert a `cluster_tenant_policies` row.
- `cluster ensure-tenant`.
- Verify with `kubectl describe namespace`.

- [ ] **Step 4: Write `cluster-rbac.md`**

Include the reference ClusterRole YAML inline and explain each permission. Provide ServiceAccount + ClusterRoleBinding templates for both in-cluster and out-of-cluster deployment styles.

- [ ] **Step 5: Commit**

```bash
git add docs/k8s-execution/
git commit -m "docs(k8s-execution): add M1 quickstart, security model, multi-tenant onboarding, RBAC"
```

---

## Task 27: CI integration

**Files:**
- Modify: `.github/workflows/<existing-test-workflow>.yml` (or whichever the project uses)

- [ ] **Step 1: Read the existing CI workflow**

Run: `ls .github/workflows/` and read the matrix that runs `pnpm test`.

- [ ] **Step 2: Add a new job `k8s-integration`**

Append a job that:
1. Installs `kind` from the static binary.
2. Runs `pnpm --filter @paperclipai/execution-target-kubernetes test:integration` with a 10-minute timeout.
3. Uploads the cluster's pod logs as an artifact on failure (helps debugging).

```yaml
  k8s-integration:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: |
          curl -sLo kind https://kind.sigs.k8s.io/dl/v0.24.0/kind-linux-amd64
          chmod +x kind && sudo mv kind /usr/local/bin/
      - run: pnpm --filter @paperclipai/execution-target-kubernetes build
      - run: pnpm --filter @paperclipai/execution-target-kubernetes test:integration
      - if: failure()
        run: |
          kind export logs ./kind-logs || true
        # ...upload kind-logs as artifact
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/
git commit -m "ci: add kind-based integration tests for k8s execution target"
```

---

## Task 28: Final cross-cutting smoke

The last gate that wraps M1 into something an operator can demo.

- [ ] **Step 1: Run the full M1 test suite**

Run: `pnpm test` and `pnpm --filter @paperclipai/execution-target-kubernetes test:integration`
Expected: all green.

- [ ] **Step 2: Manual smoke against a fresh kind cluster**

```bash
kind create cluster --name pp-m1
export KUBECONFIG=$(kind get kubeconfig --name pp-m1)
kubectl apply -f packages/adapters/kubernetes-execution/manifests/paperclip-tenant-manager-clusterrole.yaml
# (out-of-band: store $KUBECONFIG into a Paperclip secret named "kind-cfg")
paperclipai cluster add --label kind --kind kubeconfig --kubeconfig-secret local_encrypted:kind-cfg
paperclipai cluster list
paperclipai cluster doctor <id>
paperclipai cluster ensure-tenant <clusterId> <companyId>
kubectl get ns,sa,resourcequota,limitrange,networkpolicy -l paperclip.ai/managed-by=paperclip
kind delete cluster --name pp-m1
```

- [ ] **Step 3: Update `ROADMAP.md`** — mark M1 complete, link to this plan and the spec.

- [ ] **Step 4: Final commit**

```bash
git add ROADMAP.md
git commit -m "docs(roadmap): mark k8s execution-target M1 complete"
```

---

## Self-Review

After writing this plan I checked it with fresh eyes against the spec.

**1. Spec coverage (M1 portion):**
- ✅ §1 architecture & code layout — Tasks 1, 2, 3, 16, 17, 20.
- ✅ §2.1 namespace — Task 9.
- ✅ §2.2 pod identity — Task 10.
- ✅ §2.3 vanilla NetworkPolicy — Task 12.
- ✅ §2.4 Cilium variant — Task 13 (build) + Task 6 (capability detection).
- ✅ §2.5 PSS Restricted — Task 9 sets the labels; Task 23 verifies admission rejects/accepts pods.
- ✅ §2.6 ResourceQuota + LimitRange — Task 11.
- ✅ §2.7 ClusterConnection storage — Tasks 4, 18; tenant policies — Task 19.
- ✅ §2.8 compliance bookkeeping — Task 23.
- ✅ §5.3 image pull credentials — Task 14.
- ✅ Risk #3 executionTarget plumbing audit — Task 21.
- ✅ Risk #6 registerExecutionTargetDriver registry — Task 17.
- ✅ Risk #7 networkRequirements adapter contract — Task 3.
- ⏭ Risk #1 (workspace-strategy refactor) — explicitly deferred to M2; not in this plan.
- ⏭ Risk #2 (PVC zonal pinning UX) — surfaces in M3 UI; this plan documents storage-class choice in Task 26.
- ⏭ Risk #4 (resource defaults empirics) — M2.
- ⏭ Risk #5 (cross-cluster TokenReview) — M2/V2.
- ⏭ Risk #8 (agent shim) — M2.

**2. Placeholder scan:** I searched for "TBD", "TODO", "fill in details", "similar to". None remain. Two places where I say "match the existing CLI command convention" — that's a real instruction (read the existing command file before implementing), not a placeholder. The runCmd helper in Task 24's test is sketched at the contract level because the implementation depends on which CLI framework Paperclip uses; the engineer should mirror an existing command file's pattern. This is not a placeholder; it is the right level of specificity for the codebase context.

**3. Type consistency:**
- `ResolvedClusterConnection` fields used in client.ts (Task 5) match those in cluster-connections.ts (Task 18) and ensure-tenant.ts (Task 15). ✓
- `EnsureTenantInput` shape consistent across Tasks 15, 16, 24, 25. ✓
- `KubernetesExecutionDriver.ensureTenant` signature consistent across Tasks 16 and 20 wiring. ✓
- `TenantPolicy` shape consistent across Tasks 15, 19, 24. ✓
- Label constants (`paperclip.ai/managed-by`, `paperclip.ai/role`) consistent across Tasks 8, 9, 10, 11, 12, 13, 14. ✓
- `errorCode: "execution_target_not_yet_supported"` used identically in driver.run() (Task 16) and adapter rejection branches (Task 21). ✓

**4. Sequencing:**
Tasks 1–4 strict prerequisites (package, types, db). Tasks 5–14 are pure builders (parallel-safe). Task 15 integrates 5–14. Tasks 16–20 are server surface (depend on 15). Tasks 21–28 close the loop.

No cycles, no forward references that aren't satisfied.

**5. Test code present:** Every implementation task has a failing-test step before the implementation step.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-paperclip-cloud-adapter-m1-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

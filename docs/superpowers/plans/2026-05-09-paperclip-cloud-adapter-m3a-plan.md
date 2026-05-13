# Paperclip Cloud Adapter — M3a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the M2 Kubernetes execution path production-usable: real claude-code end-to-end test, real `issueGitCredentials` wired through `companySecrets`, empirically-derived resource defaults, and per-tenant Cilium DNS/CIDR DSL.

**Architecture:** One PR layered on M2. One Drizzle migration adds three columns to `cluster_tenant_policies` (`git_credentials_secret_id`, `cilium_dns_allowlist`, `cilium_egress_cidrs`). A new `git-credentials.ts` server service replaces the M2 stub; it resolves a `companySecrets` UUID via the existing `SecretProvider` registry and returns the decoded `{username, password}` JSON. A new `buildTenantCiliumPolicy` builder emits a *second* CiliumNetworkPolicy that intersects (Cilium evaluates multiple CNPs as AND) with M1's baseline CNP — M3a never mutates the M1 builder. The empirical-measurement infra from M2 is repointed at the real `agent-runtime-claude` image with a README-summarize prompt; defaults move only if peaks approach M1 limits. A new opt-in integration test gated on `ANTHROPIC_API_KEY` exercises real claude-code on kind. No new package; everything lives in existing packages.

**Tech Stack:** TypeScript, Drizzle ORM, Postgres, vitest, kind, @kubernetes/client-node, Cilium, Anthropic claude-code CLI.

**Spec reference:** `docs/superpowers/specs/2026-05-09-paperclip-cloud-adapter-m3a-addendum.md`

**Branching & merge order:**
- M3a sits on top of master after M1 (#5556) and M2 (#5558) merge.
- Branch: `feat/k8s-cloud-adapter-m3a`, single PR.
- Rebase rather than merge if either upstream PR force-pushes.

---

## File Structure

### Create
- `packages/db/src/migrations/0084_tenant_policy_m3a.sql` — adds 3 columns to `cluster_tenant_policies`.
- `packages/db/src/migrations/meta/0084_snapshot.json` — Drizzle snapshot for migration 0084.
- `server/src/services/git-credentials.ts` — `issueGitCredentials` real implementation.
- `server/src/services/git-credentials.test.ts` — unit tests against embedded postgres.
- `packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.ts` — `buildTenantCiliumPolicy` builder.
- `packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.test.ts` — unit test for builder.
- `packages/adapters/kubernetes-execution/test/integration/cilium-tenant-policy.test.ts` — kind+Cilium integration test.
- `packages/adapters/kubernetes-execution/test/integration/claude-code-real.test.ts` — opt-in real-Anthropic test.
- `packages/adapters/kubernetes-execution/test/integration/_fixtures/test-repo/README.md` — fixture README for the real-claude-code test.
- `packages/adapters/kubernetes-execution/test/integration/_fixtures/test-repo/.gitignore` — fixture gitignore.
- `packages/adapters/kubernetes-execution/test/integration/_helpers/seed-workspace.ts` — populates a PVC with the fixture repo.
- `docs/k8s-execution/cilium-recipes.md` — operator recipe doc for Cilium DSL.
- `docs/k8s-execution/sizing.md` — replaces `sizing-fake-agent.md` with real-claude-code numbers.
- `docs/k8s-execution/security-model.md` — section "Git credentials in V1" appended; create the file if absent.

### Modify
- `packages/db/src/schema/cluster_tenant_policies.ts` — add 3 columns.
- `server/src/services/cluster-tenant-policies.ts` — surface new columns in `UpsertTenantPolicyInput` / `TenantPolicyRow` / `mapRow`.
- `server/src/routes/k8s-callback.ts` — replace `issueGitCredentialsStub` with the real `git-credentials.ts` service.
- `cli/src/commands/cluster.ts` — new subcommand `cluster set-git-credentials --company <id> --secret-id <uuid>` and flag wiring on `cluster set-tenant-policy` for the Cilium arrays.
- `cli/src/commands/cluster.test.ts` — flag-parsing tests.
- `packages/adapters/kubernetes-execution/src/orchestrator/ensure-tenant.ts` — call `buildTenantCiliumPolicy` after the M1 CNP; apply if non-null.
- `packages/adapters/kubernetes-execution/test/integration/empirical-measurement.test.ts` — repoint at `agent-runtime-claude` + README-summarize prompt + 5 sequential runs.
- `packages/adapters/kubernetes-execution/src/orchestrator/resource-quota.ts` — bump `defaults` only if §3 measurements demand it (decision recorded at end of §3 task).
- `docs/k8s-execution/CHANGELOG.md` — M3a entry covering all four items.

### Delete
- `docs/k8s-execution/sizing-fake-agent.md` — replaced by `sizing.md`.

---

## Task Order (29 tasks total)

Sequential prerequisites:
1. Tasks 1–2: schema + snapshot.
2. Task 3: server service surfaces new columns.

Parallelizable after Task 3:
- Tasks 4–7: git-credentials service + route + CLI.
- Tasks 8–13: Cilium DSL builder + integration + ensure-tenant wiring + CLI.
- Tasks 14–18: real claude-code test + workspace-seed helper.
- Tasks 19–22: empirical numbers + sizing.md.

Closing:
- Tasks 23–25: docs (`security-model.md`, `cilium-recipes.md`, CHANGELOG).
- Tasks 26–29: PR opening, CI gating for opt-in tests, final smoke build, ROADMAP marker.

---

## Task 1: Migration `0084_tenant_policy_m3a.sql`

**Files:**
- Create: `packages/db/src/migrations/0084_tenant_policy_m3a.sql`
- Create: `packages/db/src/migrations/meta/0084_snapshot.json` (regenerated, see Step 5)
- Modify: `packages/db/src/schema/cluster_tenant_policies.ts`

- [ ] **Step 1: Write the schema change first**

Edit `packages/db/src/schema/cluster_tenant_policies.ts`. Replace the `companyId: …` line through to the closing `}),` of the columns object so the file matches:

```ts
import { pgTable, uuid, jsonb, timestamp, uniqueIndex, index, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { clusterConnections } from "./cluster_connections.js";
import { companySecrets } from "./company_secrets.js";

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
    /** FK -> company_secrets.id. JSON-encoded {username, password} after decryption. Nullable. */
    gitCredentialsSecretId: uuid("git_credentials_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    /** Cilium DSL: tenant-restrictive FQDN allow-list, intersected with M1 baseline. */
    ciliumDnsAllowlist: text("cilium_dns_allowlist").array().notNull().default(sql`ARRAY[]::text[]`),
    /** Cilium DSL: tenant-restrictive CIDR allow-list, intersected with M1 baseline. */
    ciliumEgressCidrs: text("cilium_egress_cidrs").array().notNull().default(sql`ARRAY[]::text[]`),
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

- [ ] **Step 2: Hand-write the SQL migration**

Drizzle's snapshot diffing isn't always stable for array defaults; we hand-write the migration and then regenerate the snapshot in Step 5.

Write `packages/db/src/migrations/0084_tenant_policy_m3a.sql`:

```sql
ALTER TABLE "cluster_tenant_policies"
  ADD COLUMN "git_credentials_secret_id" uuid;
--> statement-breakpoint
ALTER TABLE "cluster_tenant_policies"
  ADD CONSTRAINT "cluster_tenant_policies_git_credentials_secret_id_fkey"
  FOREIGN KEY ("git_credentials_secret_id") REFERENCES "company_secrets"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cluster_tenant_policies"
  ADD COLUMN "cilium_dns_allowlist" text[] NOT NULL DEFAULT ARRAY[]::text[];
--> statement-breakpoint
ALTER TABLE "cluster_tenant_policies"
  ADD COLUMN "cilium_egress_cidrs" text[] NOT NULL DEFAULT ARRAY[]::text[];
```

- [ ] **Step 3: Run the migration check + db build**

Run: `pnpm --filter @paperclipai/db build`
Expected: passes (migration numbering check + tsc + copy of `src/migrations` to `dist/migrations`).

- [ ] **Step 4: Verify schema compiles end-to-end**

Run: `pnpm --filter @paperclipai/server typecheck`
Expected: passes. If it fails on `clusterTenantPolicies.gitCredentialsSecretId` not existing, the symbol drift between `dist/` and `src/` resolved itself only after Step 3 — re-run.

- [ ] **Step 5: Generate the Drizzle snapshot**

Run: `pnpm --filter @paperclipai/db generate`
Expected: drizzle-kit emits `packages/db/src/migrations/meta/0084_snapshot.json` (and updates `_journal.json`). It MAY also try to emit a duplicate `.sql` file numbered `0084` — if so, delete the duplicate and keep the hand-written one from Step 2.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/cluster_tenant_policies.ts \
        packages/db/src/migrations/0084_tenant_policy_m3a.sql \
        packages/db/src/migrations/meta/0084_snapshot.json \
        packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): tenant policy M3a columns (git creds, Cilium DSL)"
```

---

## Task 2: Backfill default `[]` reads in existing service

**Files:**
- Modify: `server/src/services/cluster-tenant-policies.ts`
- Modify: `server/src/services/cluster-tenant-policies.test.ts`

The existing `mapRow` does not yet know about the new columns. `inferSelect` will widen automatically once the schema is regenerated, but `UpsertTenantPolicyInput` and `TenantPolicyRow` need explicit fields so callers can write them.

- [ ] **Step 1: Write the failing test**

Append to `server/src/services/cluster-tenant-policies.test.ts`:

```ts
  it("upsert() persists git_credentials_secret_id, cilium_dns_allowlist, cilium_egress_cidrs", async () => {
    const svc = clusterTenantPoliciesService(db);
    // First create a company secret to FK against.
    const secretRows = await db.execute(sql`
      INSERT INTO company_secrets (company_id, name)
      VALUES (${companyId}, 'github-pat')
      RETURNING id
    `);
    const secretId = (secretRows[0] as { id: string }).id;

    const written = await svc.upsert({
      clusterConnectionId: clusterId,
      companyId,
      quota: null,
      limitRange: null,
      additionalAllowFqdns: [],
      imageOverrides: null,
      gitCredentialsSecretId: secretId,
      ciliumDnsAllowlist: ["api.anthropic.com", "github.com"],
      ciliumEgressCidrs: ["10.42.0.0/16"],
    });
    expect(written.gitCredentialsSecretId).toBe(secretId);
    expect(written.ciliumDnsAllowlist).toEqual(["api.anthropic.com", "github.com"]);
    expect(written.ciliumEgressCidrs).toEqual(["10.42.0.0/16"]);

    const fetched = await svc.get(clusterId, companyId);
    expect(fetched?.gitCredentialsSecretId).toBe(secretId);
    expect(fetched?.ciliumDnsAllowlist).toEqual(["api.anthropic.com", "github.com"]);
    expect(fetched?.ciliumEgressCidrs).toEqual(["10.42.0.0/16"]);
  });

  it("upsert() preserves new columns when caller omits them", async () => {
    const svc = clusterTenantPoliciesService(db);
    // Re-upsert with only quota set; the M3a columns should retain their
    // previous values rather than reset to defaults.
    await svc.upsert({
      clusterConnectionId: clusterId,
      companyId,
      quota: { requestsCpu: "8" },
      limitRange: null,
      additionalAllowFqdns: [],
      imageOverrides: null,
    });
    const after = await svc.get(clusterId, companyId);
    expect(after?.gitCredentialsSecretId).not.toBeNull();
    expect(after?.ciliumDnsAllowlist?.length ?? 0).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/cluster-tenant-policies.test.ts`
Expected: FAIL — `gitCredentialsSecretId` not on `UpsertTenantPolicyInput`.

- [ ] **Step 3: Modify `cluster-tenant-policies.ts` to thread the new fields**

Replace the contents of `server/src/services/cluster-tenant-policies.ts`:

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
  /**
   * Egress HTTP proxy URL for the tenant. When omitted (undefined), any existing
   * value is preserved on upsert; pass `null` explicitly to clear it.
   */
  httpProxyUrl?: string | null;
  imageOverrides: Record<string, string> | null;
  /** FK to company_secrets.id. Omitted = preserve existing; `null` = clear. */
  gitCredentialsSecretId?: string | null;
  /** Cilium DSL: tenant-restrictive FQDN list. Omitted = preserve. Empty array = clear. */
  ciliumDnsAllowlist?: string[];
  /** Cilium DSL: tenant-restrictive CIDR list. Omitted = preserve. Empty array = clear. */
  ciliumEgressCidrs?: string[];
}

export interface TenantPolicyRow extends TenantPolicy {
  clusterConnectionId: string;
  companyId: string;
  httpProxyUrl: string | null;
  gitCredentialsSecretId: string | null;
  ciliumDnsAllowlist: string[];
  ciliumEgressCidrs: string[];
}

export interface ClusterTenantPoliciesService {
  get(clusterConnectionId: string, companyId: string): Promise<TenantPolicyRow | null>;
  upsert(input: UpsertTenantPolicyInput): Promise<TenantPolicyRow>;
}

export function clusterTenantPoliciesService(db: Db): ClusterTenantPoliciesService {
  return {
    async get(clusterConnectionId, companyId) {
      const [row] = await db.select().from(clusterTenantPolicies).where(and(
        eq(clusterTenantPolicies.clusterConnectionId, clusterConnectionId),
        eq(clusterTenantPolicies.companyId, companyId),
      ));
      return row ? mapRow(row) : null;
    },

    async upsert(input) {
      const existing = await this.get(input.clusterConnectionId, input.companyId);
      const httpProxyUrl =
        input.httpProxyUrl === undefined ? (existing?.httpProxyUrl ?? null) : input.httpProxyUrl;
      const gitCredentialsSecretId =
        input.gitCredentialsSecretId === undefined ? (existing?.gitCredentialsSecretId ?? null) : input.gitCredentialsSecretId;
      const ciliumDnsAllowlist =
        input.ciliumDnsAllowlist === undefined ? (existing?.ciliumDnsAllowlist ?? []) : input.ciliumDnsAllowlist;
      const ciliumEgressCidrs =
        input.ciliumEgressCidrs === undefined ? (existing?.ciliumEgressCidrs ?? []) : input.ciliumEgressCidrs;

      if (existing) {
        const [updated] = await db.update(clusterTenantPolicies).set({
          quotaJson: input.quota,
          limitRangeJson: input.limitRange,
          networkJson: { additionalAllowFqdns: input.additionalAllowFqdns, httpProxyUrl },
          imageOverridesJson: input.imageOverrides,
          gitCredentialsSecretId,
          ciliumDnsAllowlist,
          ciliumEgressCidrs,
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
        networkJson: { additionalAllowFqdns: input.additionalAllowFqdns, httpProxyUrl },
        imageOverridesJson: input.imageOverrides,
        gitCredentialsSecretId,
        ciliumDnsAllowlist,
        ciliumEgressCidrs,
      }).returning();
      return mapRow(created);
    },
  };
}

function mapRow(r: typeof clusterTenantPolicies.$inferSelect): TenantPolicyRow {
  return {
    clusterConnectionId: r.clusterConnectionId,
    companyId: r.companyId,
    quota: r.quotaJson ?? null,
    limitRange: r.limitRangeJson ?? null,
    additionalAllowFqdns: r.networkJson?.additionalAllowFqdns ?? [],
    httpProxyUrl: r.networkJson?.httpProxyUrl ?? null,
    imageOverrides: r.imageOverridesJson ?? null,
    gitCredentialsSecretId: r.gitCredentialsSecretId ?? null,
    ciliumDnsAllowlist: r.ciliumDnsAllowlist ?? [],
    ciliumEgressCidrs: r.ciliumEgressCidrs ?? [],
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/cluster-tenant-policies.test.ts`
Expected: all tests PASS, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/cluster-tenant-policies.ts server/src/services/cluster-tenant-policies.test.ts
git commit -m "feat(server): tenant-policy service surfaces M3a columns with preserve-on-omit"
```

---

## Task 3: `git-credentials.ts` service — happy path

**Files:**
- Create: `server/src/services/git-credentials.ts`
- Create: `server/src/services/git-credentials.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/git-credentials.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase, createDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { issueGitCredentials } from "./git-credentials.js";
import { clusterTenantPoliciesService } from "./cluster-tenant-policies.js";
import type { SecretService } from "./git-credentials.js";

let dbHandle: EmbeddedPostgresTestDatabase;
let db: Db;
let clusterId: string;
let companyId: string;

beforeAll(async () => {
  dbHandle = await startEmbeddedPostgresTestDatabase("paperclip-git-creds-");
  db = createDb(dbHandle.connectionString);
  const c = await db.execute(sql`
    INSERT INTO cluster_connections (label, kind, capabilities, created_by)
    VALUES ('seed-cluster', 'in-cluster', '{"cilium":false,"storageClass":"standard","architectures":["amd64"]}'::jsonb, 'sys')
    RETURNING id
  `);
  clusterId = (c[0] as { id: string }).id;
  const co = await db.execute(sql`INSERT INTO companies (name) VALUES ('Acme') RETURNING id`);
  companyId = (co[0] as { id: string }).id;
});
afterAll(async () => { await dbHandle.cleanup(); });

function makeFakeSecretService(map: Map<string, string>): SecretService {
  return {
    async resolve(secretId: string) {
      const v = map.get(secretId);
      if (!v) throw new Error(`secret not found: ${secretId}`);
      return v;
    },
  };
}

describe("issueGitCredentials", () => {
  it("returns not_configured when policy has no gitCredentialsSecretId", async () => {
    const r = await issueGitCredentials({
      db,
      secretService: makeFakeSecretService(new Map()),
      clusterTenantPolicies: clusterTenantPoliciesService(db),
    }, { companyId, clusterConnectionId: clusterId, repoUrl: "https://github.com/acme/repo.git" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_configured");
  });

  it("returns the decoded {username, password} when the secret resolves", async () => {
    const secretRows = await db.execute(sql`
      INSERT INTO company_secrets (company_id, name)
      VALUES (${companyId}, 'github-pat')
      RETURNING id
    `);
    const secretId = (secretRows[0] as { id: string }).id;
    await clusterTenantPoliciesService(db).upsert({
      clusterConnectionId: clusterId, companyId,
      quota: null, limitRange: null,
      additionalAllowFqdns: [], imageOverrides: null,
      gitCredentialsSecretId: secretId,
    });
    const fakeSecrets = makeFakeSecretService(new Map([
      [secretId, JSON.stringify({ username: "x-access-token", password: "ghp_test" })],
    ]));
    const r = await issueGitCredentials({
      db,
      secretService: fakeSecrets,
      clusterTenantPolicies: clusterTenantPoliciesService(db),
    }, { companyId, clusterConnectionId: clusterId, repoUrl: "https://github.com/acme/repo.git" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.username).toBe("x-access-token");
      expect(r.password).toBe("ghp_test");
      expect(typeof r.expiresAt).toBe("string");
      expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("returns internal_error when the secret material is not valid JSON", async () => {
    const secretRows = await db.execute(sql`
      INSERT INTO company_secrets (company_id, name)
      VALUES (${companyId}, 'broken-pat')
      RETURNING id
    `);
    const secretId = (secretRows[0] as { id: string }).id;
    await clusterTenantPoliciesService(db).upsert({
      clusterConnectionId: clusterId, companyId,
      quota: null, limitRange: null,
      additionalAllowFqdns: [], imageOverrides: null,
      gitCredentialsSecretId: secretId,
    });
    const fakeSecrets = makeFakeSecretService(new Map([[secretId, "not-json-at-all"]]));
    const r = await issueGitCredentials({
      db,
      secretService: fakeSecrets,
      clusterTenantPolicies: clusterTenantPoliciesService(db),
    }, { companyId, clusterConnectionId: clusterId, repoUrl: "https://github.com/acme/repo.git" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("internal_error");
  });

  it("returns internal_error when JSON lacks string username/password", async () => {
    const secretRows = await db.execute(sql`
      INSERT INTO company_secrets (company_id, name)
      VALUES (${companyId}, 'shape-bad-pat')
      RETURNING id
    `);
    const secretId = (secretRows[0] as { id: string }).id;
    await clusterTenantPoliciesService(db).upsert({
      clusterConnectionId: clusterId, companyId,
      quota: null, limitRange: null,
      additionalAllowFqdns: [], imageOverrides: null,
      gitCredentialsSecretId: secretId,
    });
    const fakeSecrets = makeFakeSecretService(new Map([
      [secretId, JSON.stringify({ username: 1234, password: null })],
    ]));
    const r = await issueGitCredentials({
      db,
      secretService: fakeSecrets,
      clusterTenantPolicies: clusterTenantPoliciesService(db),
    }, { companyId, clusterConnectionId: clusterId, repoUrl: "https://github.com/acme/repo.git" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("internal_error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/git-credentials.test.ts`
Expected: FAIL — `Cannot find module './git-credentials.js'`.

- [ ] **Step 3: Implement the service**

Create `server/src/services/git-credentials.ts`:

```ts
import type { Db } from "@paperclipai/db";
import type { ClusterTenantPoliciesService } from "./cluster-tenant-policies.js";

export interface SecretService {
  resolve(secretId: string): Promise<string>;
}

export type IssueGitCredentialsResult =
  | { ok: true; username: string; password: string; expiresAt: string }
  | { ok: false; reason: "not_configured" | "denied" | "internal_error" };

export interface IssueGitCredentialsInput {
  companyId: string;
  clusterConnectionId: string;
  repoUrl: string; // for logging/audit; M3a does not filter by URL
}

export interface IssueGitCredentialsDeps {
  db: Db;
  secretService: SecretService;
  clusterTenantPolicies: ClusterTenantPoliciesService;
}

/**
 * Resolve the per-company git credential secret and return the decoded
 * {username, password} pair. The TTL exposed to the caller is informational
 * only — the underlying companySecret is long-lived. We surface a 1h expiry
 * to keep workspace-init's contract identical to a future GitHub-App
 * implementation where the TTL becomes real.
 */
export async function issueGitCredentials(
  deps: IssueGitCredentialsDeps,
  input: IssueGitCredentialsInput,
): Promise<IssueGitCredentialsResult> {
  const policy = await deps.clusterTenantPolicies.get(input.clusterConnectionId, input.companyId);
  if (!policy?.gitCredentialsSecretId) return { ok: false, reason: "not_configured" };

  let resolved: string;
  try {
    resolved = await deps.secretService.resolve(policy.gitCredentialsSecretId);
  } catch {
    return { ok: false, reason: "internal_error" };
  }

  let parsed: { username?: unknown; password?: unknown };
  try {
    parsed = JSON.parse(resolved);
  } catch {
    return { ok: false, reason: "internal_error" };
  }

  if (typeof parsed.username !== "string" || typeof parsed.password !== "string") {
    return { ok: false, reason: "internal_error" };
  }

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return { ok: true, username: parsed.username, password: parsed.password, expiresAt };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @paperclipai/server exec vitest run src/services/git-credentials.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/git-credentials.ts server/src/services/git-credentials.test.ts
git commit -m "feat(server): real issueGitCredentials backed by companySecrets + SecretProvider"
```

---

## Task 4: Wire the real `issueGitCredentials` into the k8s-callback router

**Files:**
- Modify: `server/src/routes/k8s-callback.ts`

The M2 stub is `issueGitCredentialsStub`; replace it with a function that calls the real service. The router needs access to `clusterTenantPolicies` and a `SecretService`. The existing `plugin-secrets-handler.ts` shows how to wire `getSecretProvider` + `companySecrets` + `companySecretVersions`.

- [ ] **Step 1: Add a thin local SecretService that uses the existing provider registry**

Modify `server/src/routes/k8s-callback.ts`. At the top of the file, replace the `issueGitCredentialsStub` block with the wiring below. Show the relevant edits as one diff hunk (find/replace exact strings):

Replace this block:

```ts
/**
 * Stub git-credentials issuer. M2 ships the route + auth contract; live
 * issuance (GitHub App installation tokens, per-tenant deploy tokens) is M3.
 * Documented in docs/k8s-execution/CHANGELOG.md.
 */
async function issueGitCredentialsStub(): Promise<IssueGitCredentialsResult> {
  return { ok: false, reason: "not_configured" };
}
```

with:

```ts
import { and, eq } from "drizzle-orm";
import { companySecrets, companySecretVersions } from "@paperclipai/db";
import type { SecretProvider } from "@paperclipai/shared";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { clusterTenantPoliciesService } from "../services/cluster-tenant-policies.js";
import { issueGitCredentials, type SecretService } from "../services/git-credentials.js";

function createDbBackedSecretService(db: Db): SecretService {
  return {
    async resolve(secretId: string): Promise<string> {
      const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, secretId));
      if (!secret) throw new Error(`secret not found: ${secretId}`);
      const [versionRow] = await db
        .select()
        .from(companySecretVersions)
        .where(and(
          eq(companySecretVersions.secretId, secret.id),
          eq(companySecretVersions.version, secret.latestVersion),
        ));
      if (!versionRow) throw new Error(`secret version not found: ${secretId} v${secret.latestVersion}`);
      const provider = getSecretProvider(secret.provider as SecretProvider);
      return provider.resolveVersion({
        material: versionRow.material as Record<string, unknown>,
        externalRef: secret.externalRef ?? null,
      });
    },
  };
}
```

`and` and `eq` may already be imported at the top of the file from M2; if so, add `companySecrets, companySecretVersions` to the existing `@paperclipai/db` import line and don't double-import.

- [ ] **Step 2: Wire the new function into `k8sCallbackRoutes`**

Inside `k8sCallbackRoutes`, find the M2 stub call:

```ts
  const gitCredentialsHandler = createWorkspaceGitCredentialsRoute({
    runJwt,
    issueGitCredentials: issueGitCredentialsStub,
  });
```

Replace with:

```ts
  const tenantPolicies = clusterTenantPoliciesService(db);
  const secretService = createDbBackedSecretService(db);
  const gitCredentialsHandler = createWorkspaceGitCredentialsRoute({
    runJwt,
    issueGitCredentials: async ({ companyId, repoUrl }) => {
      // Resolve the cluster context from the run-JWT — but the M2 route does
      // not surface clusterConnectionId. The tenant policy is keyed on
      // (clusterConnectionId, companyId); for V1 we only support a single
      // cluster connection per company, so we look up the policy by company
      // alone and fail closed if there are zero or multiple matches.
      const policies = await db
        .select()
        .from(clusterTenantPolicies)
        .where(eq(clusterTenantPolicies.companyId, companyId));
      if (policies.length !== 1) {
        return { ok: false, reason: "not_configured" };
      }
      return issueGitCredentials(
        { db, secretService, clusterTenantPolicies: tenantPolicies },
        { companyId, clusterConnectionId: policies[0]!.clusterConnectionId, repoUrl },
      );
    },
  });
```

Add `clusterTenantPolicies` to the existing `@paperclipai/db` import.

- [ ] **Step 3: Adjust the route's existing test to confirm wiring shape (no behavior change)**

Open `server/src/routes/workspace-git-credentials.test.ts`. The existing tests already cover the route surface; they keep passing. No edits needed unless the typecheck fails — if so, add `as any` to match the new tighter `IssueGitCredentialsResult` shape only at the boundary.

- [ ] **Step 4: Typecheck the server**

Run: `pnpm --filter @paperclipai/server typecheck`
Expected: PASS.

- [ ] **Step 5: Run the existing route tests**

Run: `pnpm --filter @paperclipai/server exec vitest run src/routes/workspace-git-credentials.test.ts`
Expected: PASS — the stub is replaced, but the route still gates on JWT and accepts the same body shape.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/k8s-callback.ts
git commit -m "feat(server): replace M2 git-credentials stub with real companySecrets-backed issuer"
```

---

## Task 5: CLI subcommand `cluster set-git-credentials`

**Files:**
- Modify: `cli/src/commands/cluster.ts`
- Modify: `cli/src/commands/cluster.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `cli/src/commands/cluster.test.ts`:

```ts
  it("set-git-credentials: writes gitCredentialsSecretId on the tenant policy", async () => {
    const m = mocks();
    (m.tenantPolicies.upsert as any).mockResolvedValue({
      clusterConnectionId: "c-1",
      companyId: "co-1",
      quota: null, limitRange: null,
      additionalAllowFqdns: [],
      imageOverrides: null,
      gitCredentialsSecretId: "11111111-1111-1111-1111-111111111111",
      ciliumDnsAllowlist: [],
      ciliumEgressCidrs: [],
      httpProxyUrl: null,
    });
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "set-git-credentials",
      "--cluster", "c-1",
      "--company", "co-1",
      "--secret-id", "11111111-1111-1111-1111-111111111111",
    ]);
    expect(code).toBe(0);
    const arg = (m.tenantPolicies.upsert as any).mock.calls[0][0];
    expect(arg.gitCredentialsSecretId).toBe("11111111-1111-1111-1111-111111111111");
    expect(arg.clusterConnectionId).toBe("c-1");
    expect(arg.companyId).toBe("co-1");
  });

  it("set-git-credentials: rejects a non-UUID secret-id", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "set-git-credentials",
      "--cluster", "c-1",
      "--company", "co-1",
      "--secret-id", "not-a-uuid",
    ]);
    expect(code).not.toBe(0);
    expect(m.tenantPolicies.upsert).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter paperclipai exec vitest run src/commands/cluster.test.ts`
Expected: FAIL — `set-git-credentials` not a known subcommand (will surface as a non-zero exit and Usage line).

- [ ] **Step 3: Add the subcommand to `cluster.ts`**

In `cli/src/commands/cluster.ts`, add the handler. Find the dispatch table (a `switch` on subcommand inside `createClusterCommand`) and add a case `"set-git-credentials": return cmdSetGitCredentials(rest, deps);` before the `default:`.

Then add the implementation:

```ts
async function cmdSetGitCredentials(argv: string[], deps: ClusterCommandDeps): Promise<number> {
  const { flags } = parseFlags(argv);
  const clusterId = flags["cluster"];
  const companyId = flags["company"];
  const secretId  = flags["secret-id"];
  if (!clusterId || !companyId || !secretId) {
    deps.print(
      "Usage: cluster set-git-credentials --cluster <id> --company <id> --secret-id <uuid>",
    );
    return 2;
  }
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(secretId)) {
    deps.print(`Invalid --secret-id: expected a UUID, got "${secretId}"`);
    return 2;
  }

  const existing = await deps.tenantPolicies.get(clusterId, companyId);
  await deps.tenantPolicies.upsert({
    clusterConnectionId: clusterId,
    companyId,
    quota: existing?.quota ?? null,
    limitRange: existing?.limitRange ?? null,
    additionalAllowFqdns: existing?.additionalAllowFqdns ?? [],
    imageOverrides: existing?.imageOverrides ?? null,
    gitCredentialsSecretId: secretId,
  });
  deps.print(`Updated tenant policy: gitCredentialsSecretId=${secretId}`);
  return 0;
}
```

The `tenantPolicies.upsert` mock in `cluster.test.ts` already exists from M1; no `ClusterTenantPoliciesService` interface change required because the field is optional on `UpsertTenantPolicyInput` (Task 2).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter paperclipai exec vitest run src/commands/cluster.test.ts`
Expected: PASS, including both new cases.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/cluster.ts cli/src/commands/cluster.test.ts
git commit -m "feat(cli): cluster set-git-credentials subcommand"
```

---

## Task 6: `buildTenantCiliumPolicy` builder — empty-input contract

**Files:**
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.ts`
- Create: `packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.test.ts`

- [ ] **Step 1: Write the failing test for the empty-input contract**

Create `packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildTenantCiliumPolicy } from "./cilium-tenant-policy.js";

describe("buildTenantCiliumPolicy", () => {
  it("returns null when both arrays are empty (no extra CNP)", () => {
    const result = buildTenantCiliumPolicy({
      namespace: "paperclip-acme",
      companySlug: "acme",
      dnsAllowlist: [],
      egressCidrs: [],
    });
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run src/orchestrator/cilium-tenant-policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement just enough to pass**

Create `packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.ts`:

```ts
import type { CiliumNetworkPolicyDoc } from "./cilium-network-policy.js";

export interface BuildTenantCiliumInput {
  namespace: string;
  companySlug: string;
  dnsAllowlist: string[];
  egressCidrs: string[];
}

/**
 * Build a per-tenant CiliumNetworkPolicy that intersects with M1's baseline.
 *
 * Cilium evaluates multiple CNPs as an AND: traffic is allowed only when
 * every selecting policy permits it. When this builder returns a CNP, the
 * effective egress for the tenant becomes
 *   M1 baseline ∩ (kube-dns, dnsAllowlist, egressCidrs)
 * — strictly tighter than M1 alone.
 *
 * Returns `null` when both arrays are empty, in which case `ensureTenantNamespace`
 * does not apply a second CNP and the M1 baseline alone governs egress.
 */
export function buildTenantCiliumPolicy(input: BuildTenantCiliumInput): CiliumNetworkPolicyDoc | null {
  if (input.dnsAllowlist.length === 0 && input.egressCidrs.length === 0) return null;
  // Implementation continues in Task 7. This stub just satisfies the empty-input contract.
  throw new Error("not implemented for non-empty input — see Task 7");
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run src/orchestrator/cilium-tenant-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.ts \
        packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.test.ts
git commit -m "feat(k8s-execution): buildTenantCiliumPolicy returns null on empty input"
```

---

## Task 7: `buildTenantCiliumPolicy` — populated path

**Files:**
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.ts`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.test.ts`
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/cilium-network-policy.ts` (only the exported types: see Step 3)

- [ ] **Step 1: Write the failing test for the populated path**

Append to `packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.test.ts`:

```ts
  it("emits an additional CNP with kube-dns + FQDNs when dnsAllowlist is set", () => {
    const result = buildTenantCiliumPolicy({
      namespace: "paperclip-acme",
      companySlug: "acme",
      dnsAllowlist: ["api.anthropic.com", "github.com"],
      egressCidrs: [],
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.metadata.name).toBe("paperclip-tenant-acme-restrict");
    expect(result.metadata.namespace).toBe("paperclip-acme");
    expect(result.spec.endpointSelector.matchLabels["paperclip.ai/managed-by"]).toBe("paperclip");
    // Always-on kube-dns rule preserves DNS resolution for the FQDNs themselves.
    const kubeDnsRule = result.spec.egress.find((r) =>
      r.toEndpoints?.some((e) => e.matchLabels["k8s:k8s-app"] === "kube-dns"),
    );
    expect(kubeDnsRule).toBeDefined();
    // FQDN rule contains the two allowlisted hosts and uses matchName for non-wildcard entries.
    const fqdnRule = result.spec.egress.find((r) => r.toFQDNs);
    expect(fqdnRule?.toFQDNs).toEqual([{ matchName: "api.anthropic.com" }, { matchName: "github.com" }]);
  });

  it("uses matchPattern for wildcard FQDNs", () => {
    const result = buildTenantCiliumPolicy({
      namespace: "paperclip-acme",
      companySlug: "acme",
      dnsAllowlist: ["*.linear.app"],
      egressCidrs: [],
    });
    expect(result).not.toBeNull();
    const fqdnRule = result!.spec.egress.find((r) => r.toFQDNs);
    expect(fqdnRule?.toFQDNs).toEqual([{ matchPattern: "*.linear.app" }]);
  });

  it("includes a toCIDR rule when egressCidrs is set", () => {
    const result = buildTenantCiliumPolicy({
      namespace: "paperclip-acme",
      companySlug: "acme",
      dnsAllowlist: [],
      egressCidrs: ["10.42.0.0/16", "172.20.0.0/12"],
    });
    expect(result).not.toBeNull();
    const cidrRule = result!.spec.egress.find((r) => r.toCIDR);
    expect(cidrRule?.toCIDR).toEqual(["10.42.0.0/16", "172.20.0.0/12"]);
  });

  it("emits both DNS and CIDR rules when both are set", () => {
    const result = buildTenantCiliumPolicy({
      namespace: "paperclip-acme",
      companySlug: "acme",
      dnsAllowlist: ["api.anthropic.com"],
      egressCidrs: ["10.42.0.0/16"],
    });
    expect(result).not.toBeNull();
    expect(result!.spec.egress.some((r) => r.toFQDNs)).toBe(true);
    expect(result!.spec.egress.some((r) => r.toCIDR)).toBe(true);
    expect(result!.spec.egress.some((r) =>
      r.toEndpoints?.some((e) => e.matchLabels["k8s:k8s-app"] === "kube-dns"),
    )).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run src/orchestrator/cilium-tenant-policy.test.ts`
Expected: 4 new FAILs ("not implemented for non-empty input"). Empty-input case still PASSes.

- [ ] **Step 3: Extend `CiliumNetworkPolicyDoc` to include `toCIDR`**

The M1 type only has `toFQDNs`/`toEndpoints`/`toPorts`; `toCIDR` is a Cilium spec field but not yet typed. Edit `packages/adapters/kubernetes-execution/src/orchestrator/cilium-network-policy.ts` and replace this block:

```ts
    egress: Array<{
      toFQDNs?: CiliumFqdn[];
      toEndpoints?: Array<{ matchLabels: Record<string, string> }>;
      toPorts?: Array<{ ports: Array<{ port: string; protocol: string }> }>;
    }>;
```

with:

```ts
    egress: Array<{
      toFQDNs?: CiliumFqdn[];
      toEndpoints?: Array<{ matchLabels: Record<string, string> }>;
      toCIDR?: string[];
      toPorts?: Array<{
        ports: Array<{ port: string; protocol: string }>;
        rules?: { dns?: Array<{ matchPattern?: string; matchName?: string }> };
      }>;
    }>;
```

This adds `toCIDR` and the optional `rules.dns` block used by the kube-dns rule.

- [ ] **Step 4: Implement the populated builder**

Replace the body of `buildTenantCiliumPolicy` in `cilium-tenant-policy.ts` with:

```ts
import type { CiliumNetworkPolicyDoc } from "./cilium-network-policy.js";

export interface BuildTenantCiliumInput {
  namespace: string;
  companySlug: string;
  dnsAllowlist: string[];
  egressCidrs: string[];
}

export function buildTenantCiliumPolicy(input: BuildTenantCiliumInput): CiliumNetworkPolicyDoc | null {
  if (input.dnsAllowlist.length === 0 && input.egressCidrs.length === 0) return null;

  const egress: CiliumNetworkPolicyDoc["spec"]["egress"] = [];

  // Always preserve kube-dns access. Without this, an allowlist of
  // ["api.anthropic.com"] would also block DNS resolution for that host
  // and the agent would fail to resolve any FQDN at all.
  egress.push({
    toEndpoints: [{
      matchLabels: {
        "k8s:io.kubernetes.pod.namespace": "kube-system",
        "k8s:k8s-app": "kube-dns",
      },
    }],
    toPorts: [{
      ports: [{ port: "53", protocol: "ANY" }],
      rules: { dns: [{ matchPattern: "*" }] },
    }],
  });

  if (input.dnsAllowlist.length > 0) {
    egress.push({
      toFQDNs: input.dnsAllowlist.map((dns) =>
        dns.includes("*") ? { matchPattern: dns } : { matchName: dns },
      ),
    });
  }
  if (input.egressCidrs.length > 0) {
    egress.push({ toCIDR: input.egressCidrs });
  }

  return {
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: {
      name: `paperclip-tenant-${input.companySlug}-restrict`,
      namespace: input.namespace,
    },
    spec: {
      endpointSelector: { matchLabels: { "paperclip.ai/managed-by": "paperclip" } },
      egress,
    },
  };
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run src/orchestrator/cilium-tenant-policy.test.ts`
Expected: 5 PASS.

- [ ] **Step 6: Run all unit tests in the package to confirm no regression**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run test/unit src/orchestrator`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.ts \
        packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.test.ts \
        packages/adapters/kubernetes-execution/src/orchestrator/cilium-network-policy.ts
git commit -m "feat(k8s-execution): tenant Cilium DSL builder (FQDN + CIDR allowlists)"
```

---

## Task 8: Wire `buildTenantCiliumPolicy` into `ensureTenantNamespace`

**Files:**
- Modify: `packages/adapters/kubernetes-execution/src/orchestrator/ensure-tenant.ts`
- Modify: `packages/adapters/kubernetes-execution/src/index.ts` (export the new builder)

- [ ] **Step 1: Extend `TenantPolicy` to carry the new fields**

Edit `packages/adapters/kubernetes-execution/src/orchestrator/ensure-tenant.ts`. Replace:

```ts
export interface TenantPolicy {
  quota: QuotaOverride | null;
  limitRange: LimitRangeOverride | null;
  additionalAllowFqdns: string[];
  imageOverrides: Record<string, string> | null;
}
```

with:

```ts
export interface TenantPolicy {
  quota: QuotaOverride | null;
  limitRange: LimitRangeOverride | null;
  additionalAllowFqdns: string[];
  imageOverrides: Record<string, string> | null;
  /** Cilium DSL — empty array means "no extra restrictions beyond M1 baseline". */
  ciliumDnsAllowlist?: string[];
  /** Cilium DSL — empty array means "no extra CIDR restrictions". */
  ciliumEgressCidrs?: string[];
}
```

- [ ] **Step 2: Apply the second CNP after the M1 CNP**

Inside `ensureTenantNamespace`, locate the `if (input.connection.capabilities.cilium)` block. Append, immediately after the existing `applyCiliumNetworkPolicy(...)` call (still inside the same `if`):

```ts
    const tenantCnp = buildTenantCiliumPolicy({
      namespace,
      companySlug: input.company.slug,
      dnsAllowlist: input.tenantPolicy?.ciliumDnsAllowlist ?? [],
      egressCidrs: input.tenantPolicy?.ciliumEgressCidrs ?? [],
    });
    if (tenantCnp) {
      await applyCiliumNetworkPolicy(client, tenantCnp);
    }
```

Add the import at the top of the file:

```ts
import { buildTenantCiliumPolicy } from "./cilium-tenant-policy.js";
```

- [ ] **Step 3: Re-export from the package index**

Edit `packages/adapters/kubernetes-execution/src/index.ts`. After the existing `export { ensureTenantNamespace, … }` block, add:

```ts
export { buildTenantCiliumPolicy } from "./orchestrator/cilium-tenant-policy.js";
```

- [ ] **Step 4: Update unit tests for `ensureTenantNamespace`**

Open `packages/adapters/kubernetes-execution/src/orchestrator/ensure-tenant.test.ts` (it exists from M1) and add this case at the end of the existing `describe`:

```ts
  it("applies a second CNP when tenant Cilium DSL is non-empty", async () => {
    const calls: { method: string; path: string }[] = [];
    const client = makeFakeClient({
      onRequest: (m, p) => calls.push({ method: m, path: p }),
      capabilities: { cilium: true, storageClass: "standard", architectures: ["amd64"] },
    });
    await ensureTenantNamespace(client, {
      ...baseInput(),
      tenantPolicy: {
        quota: null, limitRange: null,
        additionalAllowFqdns: [],
        imageOverrides: null,
        ciliumDnsAllowlist: ["api.anthropic.com"],
        ciliumEgressCidrs: [],
      },
    });
    const cnpPaths = calls
      .filter((c) => c.path.includes("ciliumnetworkpolicies"))
      .map((c) => c.path);
    // Two distinct CNP names: M1 baseline + tenant restriction.
    expect(cnpPaths.some((p) => p.endsWith("paperclip-agent-egress-l7"))).toBe(true);
    expect(cnpPaths.some((p) => p.endsWith("paperclip-tenant-acme-restrict"))).toBe(true);
  });
```

If `makeFakeClient` and `baseInput` helpers don't exist verbatim, mirror the existing test's setup pattern in the same file. The point is: count the unique CNP paths the client receives.

- [ ] **Step 5: Run unit tests**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run src/orchestrator/ensure-tenant.test.ts`
Expected: PASS, including the new case.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/ensure-tenant.ts \
        packages/adapters/kubernetes-execution/src/orchestrator/ensure-tenant.test.ts \
        packages/adapters/kubernetes-execution/src/index.ts
git commit -m "feat(k8s-execution): apply tenant Cilium DSL as a second CNP intersecting M1 baseline"
```

---

## Task 9: Integration test on kind+Cilium proves the second CNP actually blocks

**Files:**
- Create: `packages/adapters/kubernetes-execution/test/integration/cilium-tenant-policy.test.ts`

The M1 integration tests use `_harness.ts` with `spinUpKind`. Cilium is installed in the harness only when needed; the M1 spec mentions kind+Cilium tests already exist — verify with the next step.

- [ ] **Step 1: Confirm a Cilium-enabled kind harness exists**

Run: `grep -rn "installCilium\|cilium install\|kind-cilium" packages/adapters/kubernetes-execution/test/integration/`
Expected: a helper or pattern exists. If only a simple `installCilium` helper is missing, copy the kind+Cilium setup from `network-policy-cilium.test.ts` or whichever M1 test exercises Cilium.

- [ ] **Step 2: Write the integration test**

Create `packages/adapters/kubernetes-execution/test/integration/cilium-tenant-policy.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spinUpKind, type KindCluster } from "./_harness.js";
import { installCilium, waitForCiliumReady } from "./_helpers/cilium.js";
import {
  createKubernetesApiClient,
  ensureTenantNamespace,
  type ResolvedClusterConnection,
} from "../../src/index.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execp = promisify(exec);

describe.skipIf(!process.env["K8S_INTEGRATION"])(
  "tenant Cilium DSL on kind+Cilium",
  () => {
    let kind: KindCluster;
    let connection: ResolvedClusterConnection;

    beforeAll(async () => {
      kind = spinUpKind({ withCilium: true });
      await installCilium(kind.kubeconfigPath);
      await waitForCiliumReady(kind.kubeconfigPath);
      connection = {
        id: "c-1", label: "kind-cilium", kind: "kubeconfig",
        kubeconfigYaml: kind.kubeconfigYaml,
        defaultNamespacePrefix: "paperclip-",
        allowAgentImageOverride: false,
        capabilities: { cilium: true, storageClass: "standard", architectures: ["amd64"] },
      };
    }, 600_000);

    afterAll(() => kind?.cleanup());

    it(
      "blocks egress to a host not in dnsAllowlist while permitting one that is",
      async () => {
        const client = createKubernetesApiClient(connection);
        await ensureTenantNamespace(client, {
          connection,
          company: { id: "11111111-1111-1111-1111-111111111111", slug: "acme" },
          tenantPolicy: {
            quota: null, limitRange: null,
            additionalAllowFqdns: [],
            imageOverrides: null,
            ciliumDnsAllowlist: ["example.com"],
            ciliumEgressCidrs: [],
          },
          driverServiceAccount: { name: "default", namespace: "default" },
          controlPlane: { topology: "cross-cluster", namespaceLabels: {}, podLabels: {} },
          adapterAllowFqdns: [],
          imagePullDockerConfigJson: null,
        });

        // Wait for Cilium to ingest both CNPs (the M1 baseline + the M3a restrict).
        await new Promise((r) => setTimeout(r, 3000));

        // Run a probe pod with the agent label so it matches both CNPs.
        const probeYaml = `
apiVersion: v1
kind: Pod
metadata:
  name: probe
  namespace: paperclip-acme
  labels:
    paperclip.ai/managed-by: paperclip
    paperclip.ai/role: agent-runtime
spec:
  containers:
    - name: c
      image: curlimages/curl:8.10.1
      command: ["sh", "-c", "sleep 3600"]
`;
        await execp(`kubectl --kubeconfig ${kind.kubeconfigPath} apply -f - <<'EOF'\n${probeYaml}\nEOF`);
        await execp(`kubectl --kubeconfig ${kind.kubeconfigPath} wait --for=condition=Ready pod/probe -n paperclip-acme --timeout=60s`);

        // Allowed: example.com (in dnsAllowlist).
        const allowed = await execp(
          `kubectl --kubeconfig ${kind.kubeconfigPath} exec -n paperclip-acme probe -- ` +
          `curl -sS -m 8 -o /dev/null -w "%{http_code}" https://example.com`,
        ).catch((e) => ({ stdout: "ERR", stderr: String(e) }));
        expect(allowed.stdout).toMatch(/^(2..|3..)$/);

        // Blocked: github.com (not in dnsAllowlist; M1 baseline alone would have allowed it
        // because M1 has a permissive non-RFC1918 default — the second CNP intersects it down to nothing).
        const blocked = await execp(
          `kubectl --kubeconfig ${kind.kubeconfigPath} exec -n paperclip-acme probe -- ` +
          `curl -sS -m 8 -o /dev/null -w "%{http_code}" https://github.com`,
        ).catch((e) => ({ stdout: "ERR", stderr: String(e) }));
        // We accept curl exit ≠ 0 OR HTTP 0 — Cilium drops the connection.
        expect(blocked.stdout === "ERR" || blocked.stdout === "000").toBe(true);
      },
      300_000,
    );
  },
);
```

If `_helpers/cilium.ts` doesn't exist yet, create it with:

```ts
import { execSync } from "node:child_process";

export async function installCilium(kubeconfigPath: string): Promise<void> {
  // Cilium CLI 0.16+ installs Cilium with kind defaults.
  execSync(
    `cilium install --kubeconfig ${kubeconfigPath} --version 1.16.0 --set kubeProxyReplacement=true`,
    { stdio: "inherit" },
  );
}

export async function waitForCiliumReady(kubeconfigPath: string): Promise<void> {
  execSync(
    `cilium status --wait --kubeconfig ${kubeconfigPath}`,
    { stdio: "inherit" },
  );
}
```

- [ ] **Step 3: Run the integration test locally to verify**

Run: `K8S_INTEGRATION=1 pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run test/integration/cilium-tenant-policy.test.ts`
Expected: PASS. The first run will be slow (~5 minutes) because of the kind+Cilium boot. Subsequent runs reuse cached images.

If `cilium install` is not on PATH, install it locally:

```bash
brew install cilium-cli      # macOS
# or: see https://docs.cilium.io/en/stable/gettingstarted/k8s-install-default/#install-the-cilium-cli
```

- [ ] **Step 4: Commit**

```bash
git add packages/adapters/kubernetes-execution/test/integration/cilium-tenant-policy.test.ts \
        packages/adapters/kubernetes-execution/test/integration/_helpers/cilium.ts
git commit -m "test(k8s-execution): tenant Cilium DSL actually blocks non-allowlisted egress on kind"
```

---

## Task 10: CLI flags `--cilium-dns` / `--cilium-cidrs`

**Files:**
- Modify: `cli/src/commands/cluster.ts`
- Modify: `cli/src/commands/cluster.test.ts`

The existing `cluster set-tenant-policy` (or `cmdSetTenantPolicy`) subcommand already exists from M1; it accepts `--quota-cpu`, etc. We extend it.

- [ ] **Step 1: Find the existing tenant-policy subcommand**

Run: `grep -n "set-tenant-policy\|cmdSetTenantPolicy\|cmdSetPolicy" cli/src/commands/cluster.ts`
Note the exact name. The plan refers to it as `cmdSetTenantPolicy` below; rename to match if different.

- [ ] **Step 2: Write the failing test**

Append to `cli/src/commands/cluster.test.ts`:

```ts
  it("set-tenant-policy: passes --cilium-dns and --cilium-cidrs through", async () => {
    const m = mocks();
    const cmd = createClusterCommand(m);
    const code = await cmd.run([
      "set-tenant-policy",
      "--cluster", "c-1",
      "--company", "co-1",
      "--cilium-dns", "api.anthropic.com,github.com",
      "--cilium-cidrs", "10.42.0.0/16",
    ]);
    expect(code).toBe(0);
    const arg = (m.tenantPolicies.upsert as any).mock.calls[0][0];
    expect(arg.ciliumDnsAllowlist).toEqual(["api.anthropic.com", "github.com"]);
    expect(arg.ciliumEgressCidrs).toEqual(["10.42.0.0/16"]);
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter paperclipai exec vitest run src/commands/cluster.test.ts`
Expected: FAIL — `arg.ciliumDnsAllowlist` is `undefined`.

- [ ] **Step 4: Add flag parsing**

Inside `cmdSetTenantPolicy` in `cli/src/commands/cluster.ts`, find where it builds the `upsert` input. Add these lines before the `await deps.tenantPolicies.upsert({...})`:

```ts
  const ciliumDnsAllowlist = flags["cilium-dns"]
    ? flags["cilium-dns"].split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const ciliumEgressCidrs = flags["cilium-cidrs"]
    ? flags["cilium-cidrs"].split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
```

Then add `ciliumDnsAllowlist, ciliumEgressCidrs` to the `upsert({...})` argument object.

Update the Usage line to mention the new flags.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter paperclipai exec vitest run src/commands/cluster.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/cluster.ts cli/src/commands/cluster.test.ts
git commit -m "feat(cli): cluster set-tenant-policy accepts --cilium-dns / --cilium-cidrs"
```

---

## Task 11: Real claude-code test — fixture repo

**Files:**
- Create: `packages/adapters/kubernetes-execution/test/integration/_fixtures/test-repo/README.md`
- Create: `packages/adapters/kubernetes-execution/test/integration/_fixtures/test-repo/.gitignore`

- [ ] **Step 1: Create the fixture files**

Create `packages/adapters/kubernetes-execution/test/integration/_fixtures/test-repo/README.md`:

```markdown
# paperclip-claude-test

A small test repo for claude-code integration.
```

Create an empty `packages/adapters/kubernetes-execution/test/integration/_fixtures/test-repo/.gitignore`:

```

```

(Empty file — just to look like a real repo.)

- [ ] **Step 2: Commit**

```bash
git add packages/adapters/kubernetes-execution/test/integration/_fixtures/test-repo/
git commit -m "test(k8s-execution): fixture repo for real claude-code integration test"
```

---

## Task 12: Real claude-code test — workspace seed helper

**Files:**
- Create: `packages/adapters/kubernetes-execution/test/integration/_helpers/seed-workspace.ts`

The agent test writes the fixture into a PVC by running a short setup Pod with the fixture mounted via configmap-from-tar.

- [ ] **Step 1: Write the helper**

Create `packages/adapters/kubernetes-execution/test/integration/_helpers/seed-workspace.ts`:

```ts
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Populate a PVC with a fixture directory by spinning a one-shot Pod that
 * `git init && cp -r /fixtures/* . && git add . && git commit`. The fixture
 * is delivered to the Pod via a ConfigMap (small repos only — KB scale).
 */
export async function seedWorkspaceFromFixture(input: {
  kubeconfigPath: string;
  namespace: string;
  pvcName: string;
  fixtureDir: string;          // local path to copy
  podName?: string;
}): Promise<void> {
  const podName = input.podName ?? "seed-workspace";

  // 1. Pack the fixture into a ConfigMap. ConfigMaps support up to 1Mi.
  const tmp = mkdtempSync(join(tmpdir(), "paperclip-fixture-"));
  const archive = join(tmp, "fixture.tar.gz");
  execSync(`tar -czf ${archive} -C ${input.fixtureDir} .`, { stdio: "inherit" });
  execSync(
    `kubectl --kubeconfig ${input.kubeconfigPath} -n ${input.namespace} create configmap fixture-tar --from-file=fixture.tar.gz=${archive} --dry-run=client -o yaml | kubectl --kubeconfig ${input.kubeconfigPath} apply -f -`,
    { stdio: "inherit" },
  );

  // 2. Run a one-shot Pod that unpacks the tar into the PVC + git inits.
  const podYaml = `
apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  namespace: ${input.namespace}
spec:
  restartPolicy: Never
  containers:
    - name: seed
      image: alpine/git:2.45.0
      command: ["sh", "-euxc"]
      args:
        - |
          mkdir -p /workspace
          cd /workspace
          tar -xzf /fixture/fixture.tar.gz
          git init -b main
          git -c user.email=seed@local -c user.name=seed add .
          git -c user.email=seed@local -c user.name=seed commit -m "init"
      volumeMounts:
        - name: workspace
          mountPath: /workspace
        - name: fixture
          mountPath: /fixture
  volumes:
    - name: workspace
      persistentVolumeClaim:
        claimName: ${input.pvcName}
    - name: fixture
      configMap:
        name: fixture-tar
`;
  const yamlFile = join(tmp, "pod.yaml");
  writeFileSync(yamlFile, podYaml);
  execSync(`kubectl --kubeconfig ${input.kubeconfigPath} apply -f ${yamlFile}`, { stdio: "inherit" });
  execSync(
    `kubectl --kubeconfig ${input.kubeconfigPath} wait --for=condition=Ready=false --for=jsonpath='{.status.phase}'=Succeeded pod/${podName} -n ${input.namespace} --timeout=120s`,
    { stdio: "inherit" },
  );
}
```

- [ ] **Step 2: Sanity-check by running the helper against a kind cluster**

Defer running until Task 13; the helper has no unit test (it requires kind).

- [ ] **Step 3: Commit**

```bash
git add packages/adapters/kubernetes-execution/test/integration/_helpers/seed-workspace.ts
git commit -m "test(k8s-execution): helper seeds a PVC with a fixture repo via configmap+seed-pod"
```

---

## Task 13: Real claude-code integration test

**Files:**
- Create: `packages/adapters/kubernetes-execution/test/integration/claude-code-real.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/adapters/kubernetes-execution/test/integration/claude-code-real.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spinUpKind, type KindCluster } from "./_harness.js";
import { seedWorkspaceFromFixture } from "./_helpers/seed-workspace.js";
import {
  createKubernetesApiClient,
  ensureTenantNamespace,
  type ResolvedClusterConnection,
} from "../../src/index.js";
import { createKubernetesExecutionDriver } from "../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REAL_CLAUDE_IMAGE = process.env["AGENT_CLAUDE_REAL_IMAGE"] ?? "paperclipai/agent-runtime-claude:test-m3a";

describe.skipIf(!process.env["K8S_INTEGRATION"] || !process.env["ANTHROPIC_API_KEY"])(
  "real claude-code on kind",
  () => {
    let kind: KindCluster;
    let connection: ResolvedClusterConnection;

    beforeAll(async () => {
      kind = spinUpKind();

      // Build agent-runtime-base + agent-runtime-claude into the kind cluster.
      const repoRoot = path.resolve(__dirname, "../../../../..");
      execSync(
        `docker buildx bake --file ${repoRoot}/docker/agent-runtime/buildx-bake.hcl --set "*.tags=paperclipai/agent-runtime-claude:test-m3a" agent-runtime-claude`,
        { cwd: repoRoot, stdio: "inherit" },
      );
      execSync(`kind load docker-image ${REAL_CLAUDE_IMAGE} --name ${kind.name}`, { stdio: "inherit" });

      connection = {
        id: "c-1", label: "kind", kind: "kubeconfig",
        kubeconfigYaml: kind.kubeconfigYaml,
        defaultNamespacePrefix: "paperclip-",
        allowAgentImageOverride: false,
        capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      };
    }, 900_000);

    afterAll(() => kind?.cleanup());

    it(
      "reads README.md via tool-use and surfaces the project name",
      async () => {
        const client = createKubernetesApiClient(connection);
        const ensure = await ensureTenantNamespace(client, {
          connection,
          company: { id: "55555555-5555-5555-5555-555555555555", slug: "claudereal" },
          tenantPolicy: null,
          driverServiceAccount: { name: "default", namespace: "default" },
          controlPlane: { topology: "cross-cluster", namespaceLabels: {}, podLabels: {} },
          adapterAllowFqdns: ["api.anthropic.com"],
          imagePullDockerConfigJson: null,
        });

        // PVC + workspace seed.
        execSync(
          `kubectl --kubeconfig ${kind.kubeconfigPath} -n ${ensure.namespace} apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: agent-claudereal-workspace
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 1Gi } }
  storageClassName: standard
EOF`,
          { stdio: "inherit" },
        );
        await seedWorkspaceFromFixture({
          kubeconfigPath: kind.kubeconfigPath,
          namespace: ensure.namespace,
          pvcName: "agent-claudereal-workspace",
          fixtureDir: path.resolve(__dirname, "_fixtures/test-repo"),
        });

        // Dispatch the run via the driver. The driver wires up the Job +
        // bootstrap token + ANTHROPIC_API_KEY env via the per-run Secret.
        const driver = createKubernetesExecutionDriver({
          // The driver's exact deps shape is established in M2; this object
          // mirrors it. Keep `imagesByAdapter.claude_local` pointing at the
          // real image we just loaded.
          mintBootstrapToken: async () => ({ token: "bst_test_unused", expiresAt: new Date(Date.now() + 600_000) }),
          paperclipPublicUrl: "http://example.invalid",  // not exercised — agent runs to completion before any callback
          imagesByAdapter: { claude_local: REAL_CLAUDE_IMAGE },
        });

        const result = await driver.run({
          ctx: {
            runId: "r-real-1",
            agentId: "a-claudereal",
            companyId: "55555555-5555-5555-5555-555555555555",
            companySlug: "claudereal",
            adapter: "claude_local",
            prompt: "Read README.md in /workspace and tell me the project name in one word.",
            envSecrets: { ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"]! },
            traceparent: undefined,
          },
          target: { kind: "kubernetes", connectionId: "c-1" },
        });

        expect(result.exitCode).toBe(0);
        // The driver bubbles up captured stdout in `result.logs` (M2).
        expect(result.logs.toLowerCase()).toContain("paperclip-claude-test");
      },
      900_000,
    );
  },
);
```

The test makes assumptions about driver shape that match M2 (`createKubernetesExecutionDriver`, `driver.run({ctx, target})`). If M2 lands with different names, rename here — these are wrapper-level details, not new functionality.

- [ ] **Step 2: Verify the test compiles even when skipped**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest list test/integration/claude-code-real.test.ts`
Expected: lists the test as skipped (no env vars set).

- [ ] **Step 3: Local verification with a real key (optional but recommended once)**

Run with a personal Anthropic key, scoped to a low spend cap:

```bash
ANTHROPIC_API_KEY=sk-ant-... K8S_INTEGRATION=1 \
  pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run test/integration/claude-code-real.test.ts
```

Expected: PASS in ~3–5 minutes (kind boot + image load + agent run). Cost: $0.01–0.05.

If the run fails with "no Anthropic key in container", check the `envSecrets` path in the driver — claude-code reads `ANTHROPIC_API_KEY` from env.

- [ ] **Step 4: Commit**

```bash
git add packages/adapters/kubernetes-execution/test/integration/claude-code-real.test.ts
git commit -m "test(k8s-execution): real claude-code on kind, gated on ANTHROPIC_API_KEY"
```

---

## Task 14: Repoint `empirical-measurement.test.ts` at the real image

**Files:**
- Modify: `packages/adapters/kubernetes-execution/test/integration/empirical-measurement.test.ts`

The M2 measurement test uses `buildBusyboxTestJob`; M3a swaps in the real claude-code workload.

- [ ] **Step 1: Replace the workload**

Inside the test file, replace the busybox-job construction inside the run loop with a Job that uses `agent-runtime-claude` and runs the agent-shim with the README-summarize prompt. Concretely:

1. At the top of the file, after the existing imports, add:

```ts
import { execSync } from "node:child_process";
import { seedWorkspaceFromFixture } from "./_helpers/seed-workspace.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_CLAUDE_IMAGE = process.env["AGENT_CLAUDE_REAL_IMAGE"] ?? "paperclipai/agent-runtime-claude:test-m3a";
```

2. Add an extra skip condition: `describe.skipIf(!process.env["K8S_INTEGRATION"] || !process.env["ANTHROPIC_API_KEY"])(...)`.

3. In `beforeAll`, after kind boot, build + load the real image (mirror Task 13 Step 1).

4. Replace the loop body that ran `buildBusyboxTestJob` with a Job spec that runs the real agent. The simplest reusable approach: extract a helper that wraps M2's job builder, but for this test we hand-write the Job because we want a controlled prompt and no driver coupling. Use:

```ts
function buildClaudeMeasurementJob(input: { namespace: string; jobName: string; pvcName: string; secretName: string; image: string }) {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: input.jobName, namespace: input.namespace },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: { labels: { "paperclip.ai/role": "agent-runtime", "paperclip.ai/managed-by": "paperclip" } },
        spec: {
          restartPolicy: "Never",
          containers: [{
            name: "agent",
            image: input.image,
            workingDir: "/workspace",
            command: ["/usr/bin/tini", "--"],
            args: ["claude-code", "--prompt", "Read README.md in /workspace and tell me the project name in one word."],
            envFrom: [{ secretRef: { name: input.secretName } }],
            volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
            resources: { requests: { cpu: "200m", memory: "256Mi" }, limits: { cpu: "2", memory: "1Gi" } },
          }],
          volumes: [{ name: "workspace", persistentVolumeClaim: { claimName: input.pvcName } }],
        },
      },
    },
  };
}
```

(Adjust the `args` line if the claude-code CLI takes a different flag for non-interactive prompt; verify on a local container run before committing.)

5. Wrap the existing measurement loop with `for (let run = 0; run < 5; run++) {...}`. After each run, capture peak metrics; aggregate across runs.

6. Replace the assertion at the end (which reads sizing-fake-agent.md) with a call that writes `docs/k8s-execution/sizing.md` (Task 15 covers the doc shape).

The key change for this task is the workload: the measurement should run the real claude-code 5 times.

- [ ] **Step 2: Run the test (locally) once**

Run with a real key:

```bash
ANTHROPIC_API_KEY=sk-ant-... K8S_INTEGRATION=1 \
  pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run test/integration/empirical-measurement.test.ts
```

Expected: PASS in ~10–15 minutes. The numbers are written to `docs/k8s-execution/sizing.md`. Cost: ~$0.05–0.20.

- [ ] **Step 3: Capture the numbers as test output**

The test should `console.log` peak/median/p95 CPU and memory, plus the recommended request/limit values. Capture these for the commit message.

- [ ] **Step 4: Commit**

```bash
git add packages/adapters/kubernetes-execution/test/integration/empirical-measurement.test.ts
git commit -m "test(k8s-execution): empirical measurement uses real claude-code (5 runs)"
```

---

## Task 15: Generate `docs/k8s-execution/sizing.md`

**Files:**
- Create: `docs/k8s-execution/sizing.md`
- Delete: `docs/k8s-execution/sizing-fake-agent.md`

- [ ] **Step 1: Write the doc**

Create `docs/k8s-execution/sizing.md`. Use the numbers captured in Task 14 Step 3. Template:

```markdown
# Kubernetes execution target — agent sizing

## Workload

- Image: `paperclipai/agent-runtime-claude:test-m3a` (claude-code from `@anthropic-ai/claude-code`)
- Prompt: `"Read README.md in /workspace and tell me the project name in one word."`
- Workspace: PVC seeded with a 2-file repo (README.md + .gitignore)
- Runs: 5 sequential, fresh PVC each run
- Cluster: kind v0.24.0 (Kubernetes v1.31.x), single node, on a CI runner

## Observations

| Metric    | Peak | Median | p95   |
|-----------|------|--------|-------|
| CPU (m)   | XXX  | YYY    | ZZZ   |
| Memory (Mi) | XXX | YYY  | ZZZ   |

## Recommended defaults

```yaml
resources:
  requests:
    cpu:    200m
    memory: 256Mi
  limits:
    cpu:    2
    memory: 1Gi
```

(Update if measurements indicate change — see "Decision" below.)

## Recommended ResourceQuota for a 50-agent tenant

```yaml
spec:
  hard:
    requests.cpu:    "10"
    requests.memory: "12Gi"
    limits.cpu:      "100"
    limits.memory:   "50Gi"
    count/jobs.batch: "50"
    count/persistentvolumeclaims: "50"
    count/secrets:   "200"
    count/configmaps: "100"
```

## Decision

Measured peaks (across 5 runs):
- Peak memory: XXX Mi
- Peak CPU: YYY m

Threshold for raising defaults:
- Memory: peak > 0.6 × limit (614 Mi)
- CPU: peak > 0.5 × limit (1000 m)

Decision: KEEP / RAISE TO {new values}. (Filled in by measurement run.)

## Caveats

- This is a single-turn prompt. Multi-turn sessions (real agent loops) will use more memory due to accumulated context. Operators running multi-turn workloads should monitor actual usage and raise quotas accordingly.
- Numbers are from a CI runner; production hardware may show different baselines.

## How we measured

`packages/adapters/kubernetes-execution/test/integration/empirical-measurement.test.ts` provisions kind + metrics-server, runs the workload 5 times under measurement, and writes the table above. Re-run with:

```bash
ANTHROPIC_API_KEY=... K8S_INTEGRATION=1 \
  pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run test/integration/empirical-measurement.test.ts
```

Cost: ~$0.05–0.20 per full run.
```

Replace the `XXX` / `YYY` / `ZZZ` placeholders with the captured numbers from Task 14 Step 3.

- [ ] **Step 2: Delete the obsolete fake-agent sizing doc**

```bash
git rm docs/k8s-execution/sizing-fake-agent.md
```

- [ ] **Step 3: Commit**

```bash
git add docs/k8s-execution/sizing.md
git commit -m "docs(k8s-execution): sizing.md with real-claude-code numbers, retire sizing-fake-agent.md"
```

---

## Task 16: Update default resource constants only if measurements demand it

**Files:**
- Modify (conditional): `packages/adapters/kubernetes-execution/src/orchestrator/resource-quota.ts`

- [ ] **Step 1: Decide whether to bump**

Apply the threshold from sizing.md:
- Memory: peak > 0.6 × current limit (614 Mi)? → Bump.
- CPU: peak > 0.5 × current limit (1000 m)? → Bump.

If both peaks are well under the thresholds, keep M1's defaults and skip to Step 4.

- [ ] **Step 2: If bumping, edit `resource-quota.ts`**

Update the `defaults` constant. The exact form depends on the file's current shape; the rule is **3× headroom on memory, 2× headroom on CPU** above measured peaks.

- [ ] **Step 3: Re-run the existing unit tests for the file**

Run: `pnpm --filter @paperclipai/execution-target-kubernetes exec vitest run src/orchestrator/resource-quota.test.ts`
Expected: PASS. Some snapshot tests may need updating — review the diff carefully.

- [ ] **Step 4: Commit**

If bumped:

```bash
git add packages/adapters/kubernetes-execution/src/orchestrator/resource-quota.ts \
        packages/adapters/kubernetes-execution/src/orchestrator/__snapshots__/
git commit -m "feat(k8s-execution): bump default resource limits to {new values} per M3a measurement"
```

If not bumped, write a no-op commit referencing the decision:

```bash
git commit --allow-empty -m "chore(k8s-execution): M3a measurement keeps M1 defaults (peaks well under threshold)"
```

---

## Task 17: `docs/k8s-execution/cilium-recipes.md`

**Files:**
- Create: `docs/k8s-execution/cilium-recipes.md`

- [ ] **Step 1: Write the doc**

Create `docs/k8s-execution/cilium-recipes.md`:

```markdown
# Cilium tenant policy recipes

The per-tenant Cilium DSL (`ciliumDnsAllowlist` + `ciliumEgressCidrs`) emits a
*second* CiliumNetworkPolicy that intersects with M1's baseline. Cilium evaluates
multiple selecting CNPs as AND, so every rule below produces an effective egress
that is **strictly tighter** than the M1 default — never looser.

## How to apply

```bash
paperclip cluster set-tenant-policy \
  --cluster <cluster-id> \
  --company <company-id> \
  --cilium-dns "api.anthropic.com,github.com" \
  --cilium-cidrs "10.42.0.0/16"
```

Empty arrays disable the second CNP — only the M1 baseline applies.

## Recipe 1: Anthropic-only tenant

A tenant that should reach only Anthropic + GitHub:

```bash
paperclip cluster set-tenant-policy \
  --cluster c-1 --company co-1 \
  --cilium-dns "api.anthropic.com,github.com" \
  --cilium-cidrs ""
```

The agent can hit the Anthropic API and clone GitHub repos. All other egress
(other LLM providers, arbitrary internet, internal infra) is dropped.

## Recipe 2: Self-hosted git tenant

A tenant with a self-hosted git server on an internal network:

```bash
paperclip cluster set-tenant-policy \
  --cluster c-1 --company co-1 \
  --cilium-dns "api.anthropic.com" \
  --cilium-cidrs "10.42.0.0/16"
```

`api.anthropic.com` for the LLM, `10.42.0.0/16` for the git server.

## Recipe 3: Block everything outside a small allowlist

Locking a tenant to one LLM provider and one internal repo CIDR:

```bash
paperclip cluster set-tenant-policy \
  --cluster c-1 --company co-1 \
  --cilium-dns "api.anthropic.com" \
  --cilium-cidrs "192.168.10.0/24"
```

## Footguns

- **DNS resolution is preserved automatically.** The builder always emits a
  rule allowing kube-dns; an allowlist of `["api.anthropic.com"]` does not
  accidentally block DNS resolution for that very host.
- **CIDR allowlists also need a port.** This is an M3a limitation — the second
  CNP grants TCP/443 + 80 implicitly. If the tenant needs a non-standard port
  on a CIDR, contact the operator team (M3b will add explicit port flags).
- **Wildcards.** Use `*.linear.app` for subdomain matching. The builder emits
  `matchPattern` for entries containing `*` and `matchName` otherwise.

## Verification

```bash
kubectl --kubeconfig <kubeconfig> -n paperclip-<slug> get ciliumnetworkpolicies
```

You should see two CNPs:
- `paperclip-agent-egress-l7` (M1 baseline)
- `paperclip-tenant-<slug>-restrict` (M3a tenant DSL — only when the arrays are non-empty)
```

- [ ] **Step 2: Commit**

```bash
git add docs/k8s-execution/cilium-recipes.md
git commit -m "docs(k8s-execution): cilium-recipes.md for the M3a tenant DSL"
```

---

## Task 18: `docs/k8s-execution/security-model.md` — Git credentials in V1 section

**Files:**
- Modify (or create): `docs/k8s-execution/security-model.md`

- [ ] **Step 1: Check whether the file exists**

Run: `ls docs/k8s-execution/security-model.md`
If it exists, append the section below. If not, create it with a top heading + the section.

- [ ] **Step 2: Write the section**

Append (or create with):

```markdown
## Git credentials in V1

V1 issues git credentials by resolving a per-company secret stored in
`company_secrets` and exposing it to the workspace-init container as a
`{username, password}` pair via the `/api/workspace/git-credentials` endpoint.

### Trust model

- The secret is owned by the company. Operators set it via `paperclip cluster set-git-credentials`.
- The secret is decrypted only on the server — the agent's pod never sees the wrapping ciphertext, only the resolved `{username, password}` JSON.
- The `/api/workspace/git-credentials` route requires a valid run-JWT (minted from a one-shot bootstrap token); the agent cannot exchange a JWT for credentials belonging to a different company.
- The route logs `repoUrl` for audit but does not gate on it. Any clone path the workspace-init opens uses the same credential pair.

### Limitations

- **One credential per company.** Tenants with multiple repos pointing at different orgs/hosts must use a single PAT broad enough to cover all of them, OR pick the most-restrictive shared PAT.
- **TTL is informational.** The exposed `expiresAt` is `now + 1h`, but the underlying `companySecret` is long-lived. The contract is stable so V2 (GitHub App installation tokens) can swap in a real TTL transparently.
- **No per-repo scoping.** A compromised PAT exposes every repo it has access to. Operators who need scoping must wait for V2 or use deploy keys with a separate `companySecret` per repo.

### V2 plan

V2 replaces the static PAT with a GitHub App installation token minted on-demand for the specific repo the agent is about to clone. The `/api/workspace/git-credentials` contract stays unchanged.
```

- [ ] **Step 3: Commit**

```bash
git add docs/k8s-execution/security-model.md
git commit -m "docs(k8s-execution): document V1 git-credentials trust model + limitations"
```

---

## Task 19: `docs/k8s-execution/CHANGELOG.md` — M3a entry

**Files:**
- Modify: `docs/k8s-execution/CHANGELOG.md`

- [ ] **Step 1: Append the entry**

Add at the top of the existing CHANGELOG (after the file's heading):

```markdown
## M3a — 2026-05-09

Production-readiness pass on the M2 Kubernetes execution path:

- **Real claude-code end-to-end test** (`test/integration/claude-code-real.test.ts`). Gated on `K8S_INTEGRATION=1` + `ANTHROPIC_API_KEY`. Builds the real `agent-runtime-claude` image, seeds a workspace PVC with a fixture repo, runs the agent against real Anthropic, asserts the project name surfaces in pod logs.
- **Real `issueGitCredentials`** (`server/src/services/git-credentials.ts`). Replaces the M2 stub. Resolves a `company_secrets` UUID via the existing `SecretProvider` registry, returns `{username, password}` decoded from JSON. New CLI subcommand `paperclip cluster set-git-credentials`.
- **Empirical resource defaults** (`packages/adapters/kubernetes-execution/test/integration/empirical-measurement.test.ts`). 5 sequential real-claude-code runs measured under `metrics-server`. Defaults updated only when peaks crossed M1's threshold; new sizing doc at `docs/k8s-execution/sizing.md`.
- **Per-tenant Cilium DSL** (`packages/adapters/kubernetes-execution/src/orchestrator/cilium-tenant-policy.ts`). New columns on `cluster_tenant_policies`: `cilium_dns_allowlist` + `cilium_egress_cidrs`. `ensureTenantNamespace` emits a *second* CNP that intersects with the M1 baseline (Cilium evaluates multiple CNPs as AND). Operator recipes at `docs/k8s-execution/cilium-recipes.md`.

Schema migration `0084_tenant_policy_m3a.sql` adds 3 columns (`git_credentials_secret_id`, `cilium_dns_allowlist`, `cilium_egress_cidrs`) to `cluster_tenant_policies`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/k8s-execution/CHANGELOG.md
git commit -m "docs(k8s-execution): M3a changelog entry"
```

---

## Task 20: ROADMAP marker update

**Files:**
- Modify: `docs/superpowers/specs/2026-05-08-paperclip-cloud-adapter-design.md` (or the ROADMAP table inside)

- [ ] **Step 1: Mark the four risks resolved**

Find the Risks table in the parent spec. Mark Risks #4 (empirical resource defaults) as RESOLVED. Mark the M3a addendum risks A, B, C, D with their dispositions (already documented).

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-08-paperclip-cloud-adapter-design.md
git commit -m "docs(spec): mark Risk #4 resolved by M3a; cross-link M3a addendum"
```

---

## Task 21: CI gating — guard the real-claude-code test on fork PRs

**Files:**
- Modify: `.github/workflows/k8s-integration.yml`

- [ ] **Step 1: Decide where to run the real test**

Add a separate workflow step (or a separate workflow file) that runs only on `push` to `master` and on `pull_request` from the same repo (not forks). Example block to add to `k8s-integration.yml`:

```yaml
      - name: Run real-claude-code test (gated on Anthropic key)
        if: env.ANTHROPIC_API_KEY != '' && github.event.pull_request.head.repo.fork == false
        env:
          K8S_INTEGRATION: "1"
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        working-directory: packages/adapters/kubernetes-execution
        run: pnpm exec vitest run test/integration/claude-code-real.test.ts
```

The empirical-measurement test does **not** run in CI (too slow + spends money on every push). Run on-demand via `workflow_dispatch` only — add:

```yaml
on:
  workflow_dispatch:
  # ...existing triggers
```

and a separate job behind `if: github.event_name == 'workflow_dispatch'` for the measurement test.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/k8s-integration.yml
git commit -m "ci(k8s-integration): gate real-claude-code test on Anthropic key + non-fork PRs"
```

---

## Task 22: Open the PR

**Files:** none (command-only)

- [ ] **Step 1: Push the branch**

```bash
git push -u stubbi feat/k8s-cloud-adapter-m3a
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create \
  --base master \
  --head stubbi:feat/k8s-cloud-adapter-m3a \
  --title "feat(k8s-execution): M3a — real claude-code, real git creds, empirical sizing, Cilium DSL" \
  --body "$(cat <<'EOF'
## Thinking Path

> Build M3a per the approved addendum (`docs/superpowers/specs/2026-05-09-paperclip-cloud-adapter-m3a-addendum.md`). One PR layered on M2. One migration adds three columns to `cluster_tenant_policies`. No new package.

## What Changed

- `git-credentials.ts` server service replaces the M2 stub; backed by `companySecrets` + the existing `SecretProvider` registry. New CLI subcommand `cluster set-git-credentials`.
- `buildTenantCiliumPolicy` builder + `ensureTenantNamespace` wiring: when `ciliumDnsAllowlist` or `ciliumEgressCidrs` are set, a second CiliumNetworkPolicy is applied alongside M1's baseline. Cilium intersects multiple CNPs, so M3a is strictly tightening — never relaxing.
- `claude-code-real.test.ts` opt-in integration test gated on `ANTHROPIC_API_KEY`. Builds the real `agent-runtime-claude` image, seeds a fixture repo workspace, runs the agent, asserts the project name in logs.
- `empirical-measurement.test.ts` repointed at the real claude-code workload, 5 sequential runs. New `docs/k8s-execution/sizing.md` carries the captured numbers and decision.
- Operator docs: `docs/k8s-execution/cilium-recipes.md`, `docs/k8s-execution/security-model.md` (Git credentials in V1 section).

## Verification

- [ ] `pnpm --filter @paperclipai/db build` (migration 0084 applies cleanly).
- [ ] `pnpm --filter @paperclipai/server typecheck` passes.
- [ ] `pnpm --filter @paperclipai/server test` passes (incl. new git-credentials tests).
- [ ] `pnpm --filter paperclipai test` passes (incl. CLI flag tests).
- [ ] `pnpm --filter @paperclipai/execution-target-kubernetes test` passes (incl. tenant Cilium DSL builder tests).
- [ ] `K8S_INTEGRATION=1 ANTHROPIC_API_KEY=... vitest run test/integration/claude-code-real.test.ts` passes locally.
- [ ] `K8S_INTEGRATION=1 vitest run test/integration/cilium-tenant-policy.test.ts` passes locally on a Cilium-enabled kind.

## Risks & Rollback

- Migration 0084 is additive (three nullable / default-empty columns). Rollback is `DROP COLUMN` on each — no data loss for M2 operators because the columns default to empty.
- The real-claude-code test runs on-demand and on master pushes only; no spend on every PR.
- The Cilium DSL emits a *second* CNP and never mutates M1's CNP, so disabling the feature is `--cilium-dns "" --cilium-cidrs ""` and the second CNP is no longer applied (existing CNP rows are not deleted automatically by this PR — operators delete them manually if they want to wipe state; M3b will add a `--clear` flag).

## Model Used

- Provider: Anthropic
- Model ID: claude-opus-4-7 (1M context)
- Reasoning mode: standard

## Checklist

- [x] Spec coverage: all four §1-§4 items implemented.
- [x] Migration includes both forward SQL and updated Drizzle snapshot.
- [x] No new package; all changes in existing packages.
- [x] Docs updated (sizing.md, cilium-recipes.md, security-model.md, CHANGELOG.md).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Add reviewers**

Set assignee + request review per repo conventions.

---

## Task 23: Iterate on Greptile

**Files:** none — review-driven

- [ ] **Step 1: After Greptile reviews, fix surfaced findings**

The pattern from M1/M2 was: Greptile flags TOCTOU / missing eviction / DB race patterns. Watch for:
- Atomic upsert needed in any service (`git-credentials.ts` should be safe — it only reads).
- Rate-limit eviction if a new in-memory map is introduced (none in M3a).
- Snapshot drift between hand-written SQL and `drizzle-kit generate` output.

- [ ] **Step 2: Re-trigger Greptile after pushes**

```bash
gh pr comment <pr-number> --body "@greptileai review"
```

- [ ] **Step 3: Mark all findings addressed before requesting human review**

---

## Self-Review

### Spec coverage

| Spec section | Task(s) |
|---|---|
| §1 Real claude-code test | Task 11 (fixture), Task 12 (seed helper), Task 13 (test) |
| §1 CI gating on fork PRs | Task 21 |
| §1 Documented in CHANGELOG | Task 19 |
| §2 Schema column `gitCredentialsSecretId` | Task 1 |
| §2 `git-credentials.ts` service | Task 3 |
| §2 Route wiring (replace stub) | Task 4 |
| §2 CLI subcommand `set-git-credentials` | Task 5 |
| §2 Limitations documented in `security-model.md` | Task 18 |
| §3 Empirical 5-run claude-code measurement | Task 14 |
| §3 `sizing.md` rewrite | Task 15 |
| §3 Defaults bump (or no-bump) decision | Task 16 |
| §3 Risk #4 marked resolved | Task 20 |
| §4 Schema columns `ciliumDnsAllowlist` + `ciliumEgressCidrs` | Task 1 |
| §4 `buildTenantCiliumPolicy` builder | Tasks 6+7 |
| §4 `ensureTenantNamespace` wiring | Task 8 |
| §4 Integration test on kind+Cilium | Task 9 |
| §4 CLI flags `--cilium-dns` / `--cilium-cidrs` | Task 10 |
| §4 `cilium-recipes.md` doc | Task 17 |

All spec sections have at least one task.

### Placeholder scan

- All `XXX`/`YYY`/`ZZZ` placeholders in Task 15 are explicitly captured-from-measurement values, not unfilled fields.
- No "TBD" / "TODO" / "implement later" / "add appropriate error handling" present.

### Type consistency

- `UpsertTenantPolicyInput` shape introduced in Task 2 is consumed in Task 5 + Task 10. The new fields are `gitCredentialsSecretId?`, `ciliumDnsAllowlist?`, `ciliumEgressCidrs?`. Both call sites use the same field names.
- `TenantPolicyRow` shape introduced in Task 2 is consumed in Task 4 (route wiring) and Task 16 (CLI dispatcher). Field names match.
- `IssueGitCredentialsResult` shape in Task 3 matches the existing M2 contract in `workspace-git-credentials.ts` exactly (`{ ok: true, username, password, expiresAt }` / `{ ok: false, reason }`).
- `BuildTenantCiliumInput` shape in Task 6/7 (`namespace`, `companySlug`, `dnsAllowlist`, `egressCidrs`) is consumed verbatim in Task 8.
- `CiliumNetworkPolicyDoc` is extended in Task 7 Step 3 to include `toCIDR`; Task 7's builder relies on the extension.

No type drift detected.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-paperclip-cloud-adapter-m3a-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review between tasks. Best for the parallelizable Task 6–18 cluster.
2. **Inline Execution** — execute tasks in this session in order, batched checkpoints for review.

Which approach?

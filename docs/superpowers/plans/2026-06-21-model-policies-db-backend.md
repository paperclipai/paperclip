# DB-Backed Model Policies — Backend Implementation Plan (Plan A of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move per-company model policies from the `PAPERCLIP_MODEL_POLICIES` env var to a DB table with a CRUD API, so policies are editable at runtime (no restart). Plan B (separate) adds the UI editor on top of this API.

**Architecture:** Mirror the existing **company_skills** resource end-to-end (it is the closest company-scoped editable-config analog). Store one row per company with the rules as a typed `jsonb` array (matching today's `companyId → ModelPolicyRule[]` shape). A service reads the rules with a short TTL cache + write-invalidation (dispatch reads it on every run) and **falls back to the env var when no DB row exists** (so existing config keeps working during migration). The dispatch call site in `heartbeat.ts` is already inside an async function, so it switches from the sync env read to an awaited DB read with no signature churn upstream.

**Tech Stack:** TypeScript (ESM/NodeNext), Drizzle ORM + drizzle-kit (Postgres), Express routers, Zod validation, Vitest. Packages: `@paperclipai/db`, `@paperclipai/server`. Reuses `ModelPolicyRule` from `server/src/services/model-policy.ts`.

**Out of scope (Plan B / later):** the frontend editor; per-rule rows / reordering UX (rules are edited as a whole array); migrating existing env config into the DB automatically (env remains a fallback).

---

## File Structure

- `packages/db/src/schema/company_model_policies.ts` (create) — the `company_model_policies` table (one row per company, `rules` jsonb array).
- `packages/db/src/schema/index.ts` (modify) — register the new table in the barrel.
- `packages/db/src/migrations/<generated>.sql` (generated) — via `pnpm db:generate`.
- `server/src/services/model-policy-schema.ts` (create) — a Zod schema + validator for `ModelPolicyRule[]`, reused by service and routes.
- `server/src/services/company-model-policies.ts` (create) — `companyModelPolicyService(db)`: `getCompanyPolicy` (cached, env-fallback) + `setCompanyPolicy` (upsert + invalidate).
- `server/src/services/index.ts` (modify) — export the service.
- `server/src/routes/company-model-policies.ts` (create) — GET + PUT routes (auth, validation, activity log), mirroring `company-skills.ts`.
- `server/src/routes/index.ts` + `server/src/app.ts` (modify) — register the router.
- `server/src/services/heartbeat.ts` (modify, ~line 7202) — await the DB-backed policy instead of the sync env read.
- Tests: `server/src/__tests__/model-policy-schema.test.ts`, `server/src/__tests__/company-model-policies-service.test.ts`, and a route test mirroring the existing company-skills route test.

---

### Task 1: DB schema + migration

**Files:**
- Create: `packages/db/src/schema/company_model_policies.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Write the schema**

Mirror `packages/db/src/schema/agents.ts` imports/style. Create `packages/db/src/schema/company_model_policies.ts`:

```typescript
import { pgTable, uuid, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// One row per company. `rules` mirrors the PAPERCLIP_MODEL_POLICIES per-company
// array (ModelPolicyRule[] from server/src/services/model-policy.ts).
export const companyModelPolicies = pgTable(
  "company_model_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    rules: jsonb("rules").$type<unknown[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUniqueIdx: uniqueIndex("company_model_policies_company_uniq").on(table.companyId),
  }),
);
```

> `rules` is typed `unknown[]` at the DB layer (the service validates the shape via Zod — Task 2). Confirm the import path/name of the `companies` table by checking `packages/db/src/schema/companies.ts` and how `agents.ts` imports it; match exactly.

- [ ] **Step 2: Register in the schema barrel**

In `packages/db/src/schema/index.ts`, add (match the file's existing export style):

```typescript
export { companyModelPolicies } from "./company_model_policies.js";
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @paperclipai/db build && pnpm db:generate`
Expected: a new `packages/db/src/migrations/<NNNN>_*.sql` creating `company_model_policies`. Inspect it: it must `CREATE TABLE "company_model_policies"` with the unique index on `company_id`. Do NOT hand-edit the generated SQL.

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm --filter @paperclipai/db typecheck` (expect PASS)

```bash
git add packages/db/src/schema/company_model_policies.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(db): add company_model_policies table"
```

---

### Task 2: Reusable ModelPolicyRule Zod schema

**Files:**
- Create: `server/src/services/model-policy-schema.ts`
- Test: `server/src/__tests__/model-policy-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/model-policy-schema.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { modelPolicyRulesSchema } from "../services/model-policy-schema.ts";

describe("modelPolicyRulesSchema", () => {
  it("accepts a valid rules array", () => {
    const rules = [
      { when: { workMode: ["bulk"] }, modelProfile: "bulk", reason: "x" },
      { when: {}, modelProfile: "cheap" },
    ];
    expect(modelPolicyRulesSchema.parse(rules)).toEqual(rules);
  });
  it("rejects an unknown modelProfile key", () => {
    expect(() => modelPolicyRulesSchema.parse([{ when: {}, modelProfile: "nope" }])).toThrow();
  });
  it("rejects a non-array", () => {
    expect(() => modelPolicyRulesSchema.parse({})).toThrow();
  });
  it("accepts an empty array", () => {
    expect(modelPolicyRulesSchema.parse([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/model-policy-schema.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the schema**

Create `server/src/services/model-policy-schema.ts`:

```typescript
import { z } from "zod";
import { MODEL_PROFILE_KEYS } from "@paperclipai/shared";
import type { ModelPolicyRule } from "./model-policy.ts";

const stringArray = z.array(z.string());

const matchSchema = z
  .object({
    agentRole: stringArray.optional(),
    wakeReason: stringArray.optional(),
    issuePriority: stringArray.optional(),
    workMode: stringArray.optional(),
  })
  .strict();

const ruleSchema = z
  .object({
    when: matchSchema,
    modelProfile: z.enum(MODEL_PROFILE_KEYS as unknown as [string, ...string[]]),
    reason: z.string().optional(),
  })
  .strict();

export const modelPolicyRulesSchema = z.array(ruleSchema);

export function parseModelPolicyRules(value: unknown): ModelPolicyRule[] {
  return modelPolicyRulesSchema.parse(value) as ModelPolicyRule[];
}
```

> Confirm `MODEL_PROFILE_KEYS` is exported from `@paperclipai/shared` (it is — `packages/shared/src/constants.ts`). Confirm `zod` is already a server dependency (the existing `validate(...)` route middleware uses it); if the import style differs, match the codebase.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/model-policy-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/model-policy-schema.ts server/src/__tests__/model-policy-schema.test.ts
git commit -m "feat(models): add reusable Zod schema for model policy rules"
```

---

### Task 3: DB-backed service with cache + env fallback

**Files:**
- Create: `server/src/services/company-model-policies.ts`
- Modify: `server/src/services/index.ts`
- Test: `server/src/__tests__/company-model-policies-service.test.ts`

- [ ] **Step 1: Write the failing test**

This codebase does NOT use a real/in-memory test DB for service tests — **mock the Drizzle `db` query-builder chain** (the pattern across `server/src/__tests__`). Build a fake `db` whose `select().from().where().limit()` resolves to a configurable rows array, and whose `insert(...).values(...)` / `update(...).set(...).where(...)` are `vi.fn()` spies. Create `server/src/__tests__/company-model-policies-service.test.ts` asserting:
- `getCompanyPolicy` returns `[]` for a company whose db read resolves `[]` and with no env override.
- with the db read resolving a row `{ rules: [...] }`, `getCompanyPolicy` returns those parsed rules.
- a second `getCompanyPolicy` within the TTL does NOT re-query the db (assert the select spy call count); after `setCompanyPolicy`, the cache is invalidated (next `getCompanyPolicy` re-queries).
- `setCompanyPolicy` calls insert when no existing row, update when one exists (assert the spies), and validates input (bad rule shape throws).
- `getCompanyPolicy` falls back to the env var when the db read resolves `[]`: set `process.env.PAPERCLIP_MODEL_POLICIES` to a `{ "<companyId>": [...] }` JSON in the test, expect those rules, then clear it.

Inject `now` into `getCompanyPolicy(companyId, now)` to test TTL expiry deterministically.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/company-model-policies-service.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the service**

Create `server/src/services/company-model-policies.ts`. Use `companyModelPolicies` from `@paperclipai/db` and Drizzle query style matching `server/src/services/company-skills.ts` (read that file for the exact `db.select()/insert()/update()` + `eq()` idiom and the `Db` type import):

```typescript
import { eq } from "drizzle-orm";
import { companyModelPolicies } from "@paperclipai/db";
import type { Db } from "...";                       // same Db type import as company-skills.ts
import type { ModelPolicyRule } from "./model-policy.ts";
import { parseModelPolicyRules } from "./model-policy-schema.ts";
import { getCompanyModelPolicy as getEnvCompanyModelPolicy } from "./model-policy-config.ts";

const CACHE_TTL_MS = 30_000;

export function companyModelPolicyService(db: Db) {
  const cache = new Map<string, { rules: ModelPolicyRule[]; expiresAt: number }>();

  async function readFromDb(companyId: string): Promise<ModelPolicyRule[] | null> {
    const rows = await db
      .select()
      .from(companyModelPolicies)
      .where(eq(companyModelPolicies.companyId, companyId))
      .limit(1);
    if (rows.length === 0) return null;
    try {
      return parseModelPolicyRules(rows[0].rules);
    } catch {
      return []; // a corrupt stored value must not break dispatch
    }
  }

  async function getCompanyPolicy(companyId: string, now = Date.now()): Promise<ModelPolicyRule[]> {
    const cached = cache.get(companyId);
    if (cached && cached.expiresAt > now) return cached.rules;
    const fromDb = await readFromDb(companyId);
    const rules = fromDb ?? getEnvCompanyModelPolicy(companyId); // env fallback when no DB row
    cache.set(companyId, { rules, expiresAt: now + CACHE_TTL_MS });
    return rules;
  }

  async function setCompanyPolicy(companyId: string, rawRules: unknown): Promise<ModelPolicyRule[]> {
    const rules = parseModelPolicyRules(rawRules); // validates; throws on bad shape
    const existing = await db
      .select({ id: companyModelPolicies.id })
      .from(companyModelPolicies)
      .where(eq(companyModelPolicies.companyId, companyId))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(companyModelPolicies).values({ companyId, rules });
    } else {
      await db
        .update(companyModelPolicies)
        .set({ rules, updatedAt: new Date() })
        .where(eq(companyModelPolicies.companyId, companyId));
    }
    cache.delete(companyId); // invalidate
    return rules;
  }

  return { getCompanyPolicy, setCompanyPolicy };
}

export type CompanyModelPolicyService = ReturnType<typeof companyModelPolicyService>;
```

> Replace the `Db` import placeholder with the exact type import used in `company-skills.ts`. If `now` injection conflicts with the test harness, adapt — the key behaviors are: cache hit within TTL, invalidate on write, env fallback when no row.

Register in `server/src/services/index.ts` (match existing export style):

```typescript
export { companyModelPolicyService, type CompanyModelPolicyService } from "./company-model-policies.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/company-model-policies-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/company-model-policies.ts server/src/services/index.ts server/src/__tests__/company-model-policies-service.test.ts
git commit -m "feat(models): DB-backed company model policy service with cache + env fallback"
```

---

### Task 4: CRUD routes

**Files:**
- Create: `server/src/routes/company-model-policies.ts`
- Modify: `server/src/routes/index.ts`, `server/src/app.ts`
- Test: `server/src/__tests__/company-model-policies-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Mirror `server/src/__tests__/agent-skills-routes.test.ts` (lines 1-45): it builds an express app, mounts the router, and **mocks the services via `vi.hoisted`** (no real DB). Mock `companyModelPolicyService` so its `getCompanyPolicy` returns a controllable array and `setCompanyPolicy` is a spy that echoes its validated input; mock `accessService`/`agentService` for the auth assertions exactly as the skills route test does. Create `server/src/__tests__/company-model-policies-routes.test.ts` using supertest asserting:
- `GET /companies/:companyId/model-policies` returns `{ rules: [] }` initially (200).
- `PUT /companies/:companyId/model-policies` with a valid `{ rules: [...] }` body returns the saved rules (200), and a subsequent GET returns them.
- `PUT` with an invalid rules body (bad modelProfile) returns 400.
- access to another company's policies is forbidden (mirror the company-skills auth assertion test).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/company-model-policies-routes.test.ts`
Expected: FAIL (module/route missing).

- [ ] **Step 3: Implement the routes**

Create `server/src/routes/company-model-policies.ts`, mirroring `server/src/routes/company-skills.ts` exactly for: the `Router()` factory shape, `assertCompanyAccess(req, companyId)` + the `assertCanMutate...` permission helper (reuse the same permission used by company-skills mutations, e.g. `agents:create`, unless a more fitting one exists — match company-skills), the `validate(...)` middleware, the `logActivity` call, and the response shape. Endpoints:

```typescript
// GET  /companies/:companyId/model-policies   -> { rules }
// PUT  /companies/:companyId/model-policies   body { rules } -> { rules }
```

Use a Zod body schema `z.object({ rules: modelPolicyRulesSchema })` (import from `../services/model-policy-schema.js`) with the existing `validate(...)` middleware. Use `companyModelPolicyService(db)` for reads/writes. On PUT, `logActivity(db, { companyId, action: "company.model_policy_updated", entityType: "company_model_policy", entityId: companyId, ... })` matching the company-skills activity-log call signature.

Register: in `server/src/routes/index.ts` export `companyModelPolicyRoutes`; in `server/src/app.ts` add `api.use(companyModelPolicyRoutes(db));` next to `api.use(companySkillRoutes(db))`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/company-model-policies-routes.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @paperclipai/server exec tsc --noEmit` (expect PASS)

```bash
git add server/src/routes/company-model-policies.ts server/src/routes/index.ts server/src/app.ts server/src/__tests__/company-model-policies-routes.test.ts
git commit -m "feat(models): CRUD routes for company model policies"
```

---

### Task 5: Dispatch integration (env read → awaited DB read)

**Files:**
- Modify: `server/src/services/heartbeat.ts` (~line 7202)
- Test: extend `server/src/__tests__/model-policy.test.ts` or the service test (no new behavior on the resolver; this is wiring)

- [ ] **Step 1: Confirm the call site and service availability**

Read `server/src/services/heartbeat.ts` around the `resolveModelPolicy(getCompanyModelPolicy(agent.companyId), {...})` call (~7201-7209). Confirm `db` is in scope in `executeRun` (it is — many `await ...(db)` services are used). Determine how other services are instantiated there (per-call `someService(db)` vs a shared instance) and match it.

- [ ] **Step 2: Switch to the awaited DB-backed read**

Replace the `getCompanyModelPolicy(agent.companyId)` argument (sync env read) with the awaited service call. Add the import `import { companyModelPolicyService } from "./company-model-policies.js";` and, matching the surrounding instantiation style:

```typescript
    const modelPolicyDecision = resolveModelPolicy(
      await companyModelPolicyService(db).getCompanyPolicy(agent.companyId),
      {
        agentRole: agent.role as AgentRole,
        wakeReason: readNonEmptyString(context.wakeReason) ?? undefined,
        issuePriority: issueContext?.priority ?? undefined,
        workMode: issueContext?.workMode ?? undefined,
      },
    );
```

> If services are instantiated once at the top of `executeRun`/module rather than inline, follow that pattern instead (instantiate `companyModelPolicyService(db)` once and reuse) so the TTL cache is shared across runs rather than rebuilt per call. Prefer a module-level/shared instance so the cache actually persists — note which you chose.

Remove the now-unused `getCompanyModelPolicy` import from heartbeat.ts if nothing else uses it (the env-fallback still lives inside the service). Keep `getCompanyModelPolicy` exported from `model-policy-config.ts` (the service depends on it).

- [ ] **Step 3: Verify the full suite**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/model-policy.test.ts src/__tests__/model-policy-config.test.ts src/__tests__/heartbeat-model-profile.test.ts src/__tests__/company-model-policies-service.test.ts src/__tests__/company-model-policies-routes.test.ts`
Expected: PASS

Run: `pnpm --filter @paperclipai/server exec tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/src/services/heartbeat.ts
git commit -m "feat(models): dispatch reads model policy from DB (env fallback retained)"
```

---

## Self-Review

**Spec coverage:**
- DB table for per-company policies → Task 1. ✅
- Validated rule shape (reused by service + routes) → Task 2. ✅
- Service with cache + write-invalidation + env fallback → Task 3. ✅
- CRUD API (GET/PUT, auth, validation, activity log) mirroring company_skills → Task 4. ✅
- Dispatch reads from DB (async), env fallback retained for migration → Task 5. ✅
- UI is explicitly Plan B (separate), consuming this API.

**Placeholder scan:** The `Db` type import and the test-harness reuse are explicit "mirror company-skills" instructions with a named source file to copy from — not vague placeholders. The migration SQL is generated (not hand-written) by design.

**Type consistency:** `ModelPolicyRule` (from `model-policy.ts`) is the shared type across schema-validation (`parseModelPolicyRules`), service (`getCompanyPolicy`/`setCompanyPolicy`), and dispatch. `modelPolicyRulesSchema` is defined in Task 2 and consumed in Tasks 3-4. `companyModelPolicies` (Task 1) is imported by the Task 3 service. `companyModelPolicyService` (Task 3) is consumed by Tasks 4-5.

**Risk notes:**
- **DB test harness:** Tasks 3-4 depend on however company-skills tests construct `db`. The executor must read that test first; if there is no lightweight DB harness (only a real Postgres), flag it — the service/route tests may need the project's test-DB setup, which is a prerequisite to surface, not guess.
- **Cache scope:** Task 5 must use a shared/module-level service instance so the TTL cache persists across runs; a per-call instance would make the cache useless (correct but pointless). Called out in Task 5 Step 2.
- **Env fallback:** retained so existing `PAPERCLIP_MODEL_POLICIES` deployments keep working until policies are written via the API; a company with a DB row ignores the env var.

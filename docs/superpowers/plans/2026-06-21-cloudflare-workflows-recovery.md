# Cloudflare Workflows for Recovery Orchestration — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove Cloudflare Workflows as durable orchestration by replacing the recovery subsystem's full-table poll cadence with one durable per-action Workflow instance — in observational **shadow** mode by default, opt-in per company — without changing recovery behavior.

**Architecture:** Approach A (thin orchestrator + server-as-API). A new plain Cloudflare **Workflow** (`RecoveryWorkflow`, one instance per recovery action, `instance_id = actionId`) owns only the durable timer/position. The existing Node server stays the single Postgres writer and exposes an authenticated internal API the Workflow drives (`attempt?mode=dry|active`, `get`, `resolve|escalate`). A per-company env allowlist selects shadow vs authority. Approach B (edge-native) is the documented Phase 2 destination, not built here.

**Tech Stack:** TypeScript (ESM/NodeNext), Cloudflare Workers + Workflows (`wrangler`, `WorkflowEntrypoint`), `@cloudflare/vitest-pool-workers`, Express (server internal routes), Drizzle ORM, Zod, Vitest. Packages: new `@paperclipai/recovery-workflow` (CF Worker), `@paperclipai/server`, `@paperclipai/db`.

Spec: `docs/superpowers/specs/2026-06-21-cloudflare-workflows-recovery-design.md`
Research: `.superpowers/sdd/rd-cloudflare-workflows.md`, `.superpowers/sdd/rd-recovery-lifecycle.md`

## Global Constraints

- **Faithful behavior:** Phase 1 must NOT change recovery behavior. No new `maxAttempts` cap, no `escalated`-state transition, no auto-resolution. Mirror today's cadence (`heartbeatSchedulerIntervalMs`). (Spec: Non-goals.)
- **Single writer:** the server is the only Postgres writer. The Workflow never writes Postgres directly. (Spec: Architecture.)
- **Flag-off is a strict no-op:** with no company in the allowlist, behavior is byte-identical to today and all existing recovery tests pass unchanged. (Spec: Goals/Acceptance.)
- **Shadow default:** `mode=dry` performs NO writes/side-effects. Only `mode=active` (flagged company) invokes real attempt logic. (Spec: Lifecycle.)
- **Idempotency:** attempts dedupe on `(actionId, attemptNumber)`; workflow start dedupes on `instance_id=actionId` (catch-duplicate→get). (Spec: Error handling.)
- **Plain Workflows, not `AgentWorkflow`.** (Spec: Non-goals.)
- **Drizzle drift:** after `pnpm db:generate`, trim the generated migration to ONLY the new table; keep the regenerated snapshot. (Project memory: drizzle-snapshot-drift.)
- **ESM extensions:** production server/db source imports local files with `.js`; test files may use `.ts`. (Learned in the model-policy work.)
- **Internal API auth:** every `/internal/recovery/*` endpoint requires a shared service secret and is company-scoped; reject otherwise with 401/403.

---

### Task 1: Link table `recovery_workflow_links` + migration

**Files:**
- Create: `packages/db/src/schema/recovery_workflow_links.ts`
- Modify: `packages/db/src/schema/index.ts`
- Generated: `packages/db/src/migrations/<NNNN>_*.sql` (trim per Global Constraints)

**Interfaces:**
- Produces: `recoveryWorkflowLinks` Drizzle table with columns `id` (uuid pk), `companyId` (uuid, FK companies.id), `actionId` (uuid, FK issue_recovery_actions.id), `instanceId` (text, the CF workflow instance id), `mode` (text: `'shadow' | 'active'`), `createdAt`, `updatedAt`; UNIQUE index on `actionId`.

- [ ] **Step 1: Write the schema** — mirror `packages/db/src/schema/company_model_policies.ts` (same import style; confirm the `companies` + `issueRecoveryActions` table import names).

```typescript
import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issueRecoveryActions } from "./issue_recovery_actions.js";

// One row per recovery action: maps it to its Cloudflare Workflow instance + mode.
export const recoveryWorkflowLinks = pgTable(
  "recovery_workflow_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    actionId: uuid("action_id").notNull().references(() => issueRecoveryActions.id),
    instanceId: text("instance_id").notNull(),
    mode: text("mode").notNull().default("shadow"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    actionUniqueIdx: uniqueIndex("recovery_workflow_links_action_uniq").on(table.actionId),
  }),
);
```

> Confirm the schema filename for the recovery actions table (`issue_recovery_actions.ts`) and its exported symbol name by reading `packages/db/src/schema/`; match the import exactly.

- [ ] **Step 2: Register in the barrel** — in `packages/db/src/schema/index.ts` add (match existing style):

```typescript
export { recoveryWorkflowLinks } from "./recovery_workflow_links.js";
```

- [ ] **Step 3: Generate + trim the migration**

Run: `pnpm --filter @paperclipai/db build && pnpm db:generate`
Inspect the generated `.sql`. Per Global Constraints (Drizzle drift), **trim it to ONLY**: `CREATE TABLE "recovery_workflow_links"`, its two FK `ADD CONSTRAINT`s, and the unique index. Remove any unrelated tables/columns. Keep the regenerated `*_snapshot.json`.

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm --filter @paperclipai/db typecheck` (expect PASS)

```bash
git add packages/db/src/schema/recovery_workflow_links.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(db): add recovery_workflow_links table"
```

---

### Task 2: Server attempt adapter — `planAttempt()` extraction (dry/active)

**Files:**
- Read first: `server/src/services/recovery/service.ts` (the `escalateStrandedAssignedIssue` fn, ~line 2178) and `server/src/services/issue-recovery-actions.ts`.
- Create: `server/src/services/recovery-workflow-adapter.ts`
- Test: `server/src/__tests__/recovery-workflow-adapter.test.ts`

**Interfaces:**
- Consumes: existing `escalateStrandedAssignedIssue(input)`, `issueRecoveryActionService(db).getActiveForIssue`, `.resolveActiveForIssue`.
- Produces: `recoveryWorkflowAdapter(db, deps)` returning:
  - `getState(companyId, actionId): Promise<{ active: boolean; status: string; attemptCount: number } | null>`
  - `performAttempt(input: { companyId; actionId; sourceIssueId; attemptNumber; mode: "dry" | "active" }): Promise<{ active: boolean; status: string; attemptCount: number; nextIntervalMs: number }>`
  - `resolve(input)` / `escalate(input)` thin wrappers over `resolveActiveForIssue`.

> **This is the load-bearing refactor (spec Risk 1).** `escalateStrandedAssignedIssue` currently reads + decides + writes atomically. Extract a pure **`planAttempt(ctx)`** that does the reads/decision (owner resolution, would-wake vs board-escalation, still-active?) and returns a plan object; `performAttempt(mode:"active")` executes the plan's writes (reusing the existing write path), `mode:"dry"` returns the plan with NO writes. Keep the refactor surgical: the existing active code path must remain behavior-identical (existing recovery tests must still pass — verified in Task 4). `nextIntervalMs` = the configured `heartbeatSchedulerIntervalMs` (faithful cadence).

- [ ] **Step 1: Write the failing test** — mock `db` + the recovery deps (mirror `server/src/__tests__/company-model-policies-service.test.ts` mocking style). Assert:
  - `performAttempt(mode:"dry")` returns `{ active, attemptCount, nextIntervalMs }` and performs **no writes** (spy `escalateStrandedAssignedIssue`'s write path / `upsertSourceScoped` is NOT called).
  - `performAttempt(mode:"active")` invokes the real attempt path exactly once.
  - `getState` returns `{ active:false }` when no active action; `{ active:true, attemptCount }` when one exists.
  - idempotency: same `attemptNumber` twice in `active` mode acts once (dedupe).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/recovery-workflow-adapter.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — read `escalateStrandedAssignedIssue`, extract `planAttempt`, build the adapter per the Interfaces contract. Use `.js` local imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/recovery-workflow-adapter.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @paperclipai/server exec tsc --noEmit` (expect PASS)

```bash
git add server/src/services/recovery-workflow-adapter.ts server/src/services/recovery/service.ts server/src/__tests__/recovery-workflow-adapter.test.ts
git commit -m "feat(recovery): attempt adapter with dry-run plan extraction"
```

---

### Task 3: Server internal recovery API + auth guard

**Files:**
- Create: `server/src/routes/internal-recovery.ts`
- Create: `server/src/routes/internal-auth.ts` (shared-secret middleware) — or reuse an existing internal guard if one exists (check `server/src/routes/`).
- Modify: `server/src/routes/index.ts`, `server/src/app.ts`
- Test: `server/src/__tests__/internal-recovery-routes.test.ts`

**Interfaces:**
- Consumes: `recoveryWorkflowAdapter` (Task 2).
- Produces: `internalRecoveryRoutes(db)` mounting:
  - `GET  /internal/recovery/:actionId` → `{ active, status, attemptCount }`
  - `POST /internal/recovery/:actionId/attempt` body `{ companyId, sourceIssueId, attemptNumber, mode }` → `{ active, status, attemptCount, nextIntervalMs }`
  - `POST /internal/recovery/:actionId/resolve` and `/escalate` body `{ companyId, sourceIssueId, outcome?, note? }` → `{ status }`
  - All require header `x-internal-secret` matching `PAPERCLIP_INTERNAL_API_SECRET`; 401 if missing/wrong.

- [ ] **Step 1: Write the failing test** — express app + supertest, mock `recoveryWorkflowAdapter` via `vi.hoisted` (mirror `server/src/__tests__/company-model-policies-routes.test.ts`). Assert: 401 without/with wrong secret; 200 + body shape for `GET` and `attempt` (dry); `attempt` validates `mode` (Zod) → 400 on bad input; `resolve` returns `{ status }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/internal-recovery-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — the auth middleware (constant-time compare of `x-internal-secret`), the router with Zod body validation via the existing `validate(...)` middleware, calling the adapter. `.js` imports. Register in `routes/index.ts` + mount in `app.ts` next to other `api.use(...)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/internal-recovery-routes.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @paperclipai/server exec tsc --noEmit` (expect PASS)

```bash
git add server/src/routes/internal-recovery.ts server/src/routes/internal-auth.ts server/src/routes/index.ts server/src/app.ts server/src/__tests__/internal-recovery-routes.test.ts
git commit -m "feat(recovery): internal recovery API for workflow orchestration"
```

---

### Task 4: Feature flag + trigger hook + poll-loop skip

**Files:**
- Create: `server/src/services/recovery-workflow-flag.ts` (parse `PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES`)
- Create: `server/src/services/recovery-workflow-trigger.ts` (start/ensure a CF workflow instance via REST API; `instance_id=actionId`; catch-duplicate→get)
- Modify: `server/src/services/issue-recovery-actions.ts` (call the trigger on new active action — injected dep, not a hard import) AND the poll loop site `server/src/index.ts` (~line 745) / `reconcileStrandedAssignedIssues` to **skip flagged companies**
- Test: `server/src/__tests__/recovery-workflow-flag.test.ts`, `server/src/__tests__/recovery-workflow-trigger.test.ts`

**Interfaces:**
- Produces:
  - `isRecoveryWorkflowEnabled(companyId): boolean` (allowlist; empty ⇒ false/all-shadow-only)
  - `recoveryWorkflowTrigger(cfg).ensureInstance({ companyId, actionId, sourceIssueId, mode }): Promise<{ instanceId: string }>` — POSTs to the CF Workflows REST API; on duplicate-id, returns existing.
- Consumes: nothing from Workflow side (REST only).

- [ ] **Step 1: Write the failing tests**
  - flag: `isRecoveryWorkflowEnabled` true only for listed ids; empty/undefined env ⇒ false; whitespace-tolerant.
  - trigger: mock `fetch`; asserts POST to `…/workflows/{name}/instances` with `instance_id=actionId`; on a duplicate-id error response, calls GET and resolves with the existing instance id (no throw).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/recovery-workflow-flag.test.ts src/__tests__/recovery-workflow-trigger.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** flag + trigger (use `fetch`; config: account id, workflow name, CF API token, internal-secret passthrough). Wire the trigger as an **injected optional dep** into `issueRecoveryActionService` so flag-off / no-config ⇒ never called (keeps existing tests untouched). In `reconcileStrandedAssignedIssues`, skip companies where `isRecoveryWorkflowEnabled(companyId) && mode==="active"` (authority handoff). Default/no env ⇒ no skip.

- [ ] **Step 4: Run tests + the existing recovery suite to verify no behavior change**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/recovery-workflow-flag.test.ts src/__tests__/recovery-workflow-trigger.test.ts`
Expected: PASS
Run the existing recovery tests: `pnpm --filter @paperclipai/server exec vitest run src/services/recovery/ src/__tests__` (focus on recovery-related files)
Expected: PASS (flag-off no-op).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @paperclipai/server exec tsc --noEmit` (expect PASS)

```bash
git add server/src/services/recovery-workflow-flag.ts server/src/services/recovery-workflow-trigger.ts server/src/services/issue-recovery-actions.ts server/src/index.ts server/src/__tests__/recovery-workflow-flag.test.ts server/src/__tests__/recovery-workflow-trigger.test.ts
git commit -m "feat(recovery): per-company workflow flag, trigger, and poll-loop skip"
```

---

### Task 5: Cloudflare Worker package scaffold

**Files:**
- Create: `packages/recovery-workflow/package.json` (name `@paperclipai/recovery-workflow`), `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `src/index.ts` (entry exporting the workflow class), `src/types.ts`
- Reference: `packages/plugins/sandbox-providers/cloudflare/` for the existing CF Worker package conventions.

**Interfaces:**
- Produces: a buildable Worker package with a `RecoveryWorkflow extends WorkflowEntrypoint<Env, Params>` skeleton (no loop logic yet) and a `vitest-pool-workers` config that can import it.

- [ ] **Step 1: Scaffold config** — `wrangler.jsonc` declares the workflow binding:

```jsonc
{
  "name": "paperclip-recovery-workflow",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-09",
  "compatibility_flags": ["nodejs_compat"],
  "workflows": [
    { "name": "recovery-workflow", "binding": "RECOVERY_WORKFLOW", "class_name": "RecoveryWorkflow" }
  ],
  "vars": { "INTERNAL_API_BASE_URL": "" }
}
```

- [ ] **Step 2: Skeleton workflow + Env/Params types** (`src/types.ts`, `src/index.ts`):

```typescript
// src/types.ts
export interface RecoveryWorkflowParams {
  companyId: string;
  actionId: string;
  sourceIssueId: string;
  mode: "shadow" | "active";
}
export interface Env {
  RECOVERY_WORKFLOW: Workflow;
  INTERNAL_API_BASE_URL: string;
  INTERNAL_API_SECRET: string;
}
```

```typescript
// src/index.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, RecoveryWorkflowParams } from "./types.ts";

export class RecoveryWorkflow extends WorkflowEntrypoint<Env, RecoveryWorkflowParams> {
  async run(event: WorkflowEvent<RecoveryWorkflowParams>, step: WorkflowStep): Promise<void> {
    // loop logic added in Task 6
    await step.do("noop", async () => {});
  }
}
export default { fetch() { return new Response("ok"); } };
```

- [ ] **Step 3: Add vitest-pool-workers config + a trivial test** asserting the package builds and the class is importable.

```typescript
// vitest.config.ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
export default defineWorkersConfig({
  test: { poolOptions: { workers: { wrangler: { configPath: "./wrangler.jsonc" } } } },
});
```

- [ ] **Step 4: Install deps + run the trivial test**

Run: `pnpm --filter @paperclipai/recovery-workflow install` (add devDeps: `wrangler`, `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`, `vitest`)
Run: `pnpm --filter @paperclipai/recovery-workflow exec vitest run`
Expected: PASS (trivial).

- [ ] **Step 5: Commit**

```bash
git add packages/recovery-workflow/ pnpm-lock.yaml
git commit -m "feat(recovery-workflow): scaffold Cloudflare Worker package"
```

---

### Task 6: `RecoveryWorkflow` loop logic + tests

**Files:**
- Modify: `packages/recovery-workflow/src/index.ts`
- Create: `packages/recovery-workflow/src/internal-client.ts`
- Test: `packages/recovery-workflow/test/recovery-workflow.test.ts`

**Interfaces:**
- Consumes: the server internal API (Task 3) via `internal-client.ts` (typed `attempt`, `getState`).
- Produces: a `run()` that loops: `step.do("attempt-{n}")` → call `attempt`; if `!active` break; else `step.sleep("wait-{n}", nextIntervalMs)`; raced against `step.waitForEvent("cancel")`.

- [ ] **Step 1: Write the failing test** (vitest-pool-workers) — mock the internal API (intercept `fetch` or inject the client) to return `active:true` for N attempts then `active:false`. Assert: `attempt` called N+1 times with incrementing `attemptNumber`; sleeps between; loop exits on `active:false`; a `cancel` event short-circuits the loop. Use the pool's instant-sleep + `waitForEvent` mocking.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/recovery-workflow exec vitest run`
Expected: FAIL.

- [ ] **Step 3: Implement** the internal client (POST `attempt` with `x-internal-secret`, GET state) and the `run()` loop with idempotent step names and the cancel-event race. Pass `mode` from params.

```typescript
// run() core (illustrative — match the verified Workflows API):
async run(event, step) {
  const { companyId, actionId, sourceIssueId, mode } = event.payload;
  const client = makeClient(this.env);
  let n = 0;
  while (true) {
    n += 1;
    const res = await step.do(`attempt-${n}`, { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" } },
      () => client.attempt({ companyId, actionId, sourceIssueId, attemptNumber: n, mode }));
    if (!res.active) return;
    const cancelled = await Promise.race([
      step.sleep(`wait-${n}`, res.nextIntervalMs).then(() => false),
      step.waitForEvent(`cancel-${n}`, { type: "cancel" }).then(() => true),
    ]);
    if (cancelled) return;
  }
}
```

> Verify `step.waitForEvent` + sleep-race against the docs at implementation time; if `waitForEvent` cannot be raced this way, fall back to a per-iteration `getState` check before the next attempt (the loop already self-exits on `!active`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/recovery-workflow exec vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/recovery-workflow/src/ packages/recovery-workflow/test/
git commit -m "feat(recovery-workflow): durable attempt/sleep loop with cancel"
```

---

### Task 7: Shadow diff harness

**Files:**
- Create: `server/src/services/recovery-workflow-shadow.ts` (record + compare)
- Test: `server/src/__tests__/recovery-workflow-shadow.test.ts`

**Interfaces:**
- Produces: `recordShadowDecision(db, { actionId, attemptNumber, workflowPlan })` and `diffShadow(db, { actionId })` returning mismatches vs the live loop's actual actions. Persist shadow decisions on the `recovery_workflow_links` row (or a small `evidence` jsonb column) — reuse the link table; no new table.

- [ ] **Step 1: Write the failing test** — given a recorded workflow plan and the live action's actual outcome, `diffShadow` flags agreement vs mismatch (same owner-wake decision / same active/terminal call). Mock db.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/recovery-workflow-shadow.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the recorder/differ; have the `attempt?mode=dry` path (Task 3) call `recordShadowDecision`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/server exec vitest run src/__tests__/recovery-workflow-shadow.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @paperclipai/server exec tsc --noEmit` (expect PASS)

```bash
git add server/src/services/recovery-workflow-shadow.ts server/src/__tests__/recovery-workflow-shadow.test.ts server/src/routes/internal-recovery.ts
git commit -m "feat(recovery): shadow decision recorder + diff harness"
```

---

### Task 8: Deploy + live integration runbook (GATED on Cloudflare credentials)

**Files:**
- Create: `packages/recovery-workflow/README.md` (deploy + smoke-test runbook)
- Create: `docs/superpowers/runbooks/2026-06-21-recovery-workflow-golive.md`

> **This task requires the user's Cloudflare account, `wrangler login`, and secrets** (`INTERNAL_API_SECRET`, CF API token, account id) — it cannot be completed autonomously. The executor writes the runbook and prepares commands; the human runs the live steps.

- [ ] **Step 1: Write the deploy runbook** — exact commands: `wrangler deploy` for the worker; set secrets via `wrangler secret put INTERNAL_API_SECRET`; set the server env (`PAPERCLIP_INTERNAL_API_SECRET`, `PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES=<one test company>`, CF account id + API token + workflow name). Document how the server reaches the internal API (public base URL or tunnel).

- [ ] **Step 2: Write the smoke-test procedure** — trigger a real recovery action for the test company; confirm a Workflow instance is created (`wrangler workflows instances list recovery-workflow`); confirm shadow decisions recorded; verify `diffShadow` shows agreement; then flip one company to authority and confirm the poll loop skips it and the workflow drives attempts.

- [ ] **Step 3: Commit the docs**

```bash
git add packages/recovery-workflow/README.md docs/superpowers/runbooks/2026-06-21-recovery-workflow-golive.md
git commit -m "docs(recovery-workflow): deploy + live integration runbook"
```

- [ ] **Step 4: Hand off to the user** for the live deploy/smoke test (credentials required).

---

## Self-Review

**Spec coverage:**
- CF Worker + plain Workflow, one instance/action, server-triggered → Tasks 5, 6, 4. ✅
- Server-as-API (attempt dry/active, get, resolve/escalate, auth) → Tasks 2, 3. ✅
- Dry-run = no side effects; active = real attempt → Task 2 (adapter), Task 3 (route). ✅
- Per-company flag + poll-loop skip; flag-off no-op → Task 4. ✅
- Link table side-table (not new columns) → Task 1. ✅
- Idempotency (attemptNumber, instance id) → Tasks 2, 3, 4, 6. ✅
- Durable sleep/timer owned by workflow; cancel via event → Task 6. ✅
- Shadow diff harness (acceptance signal) → Task 7. ✅
- Local TDD via vitest-pool-workers + server vitest → Tasks 5, 6 + 2, 3, 4, 7. ✅
- Live deploy/integration (gated) → Task 8. ✅
- Faithful behavior (no maxAttempts/escalation/auto-resolve) → enforced in Tasks 2, 4 + Global Constraints. ✅

**Placeholder scan:** Task 2's adapter and Task 6's loop intentionally instruct the implementer to read the named source / verify the named API at implementation time rather than pasting unverified internals — the seam, contract, files, and tests are concrete. Migration SQL is generated+trimmed by design. No "TBD"/"handle edge cases" placeholders.

**Type consistency:** `instance_id = actionId` and the `{ active, status, attemptCount, nextIntervalMs }` attempt contract are used identically in Tasks 2 (adapter), 3 (route), 6 (workflow client). `mode: "shadow"|"active"` consistent across Tasks 1, 4, 5, 6. `recoveryWorkflowLinks.actionId` unique — consistent with one-instance-per-action.

**Risk notes:**
- Task 2 (planAttempt extraction) is the highest-risk; if `escalateStrandedAssignedIssue` is too entangled to split cleanly, the executor should flag it — a fallback is a dry-run that calls `getActiveForIssue` + a read-only owner-resolution copy, accepting some duplication, rather than refactoring the write path.
- Task 8 is human-gated; Tasks 1–7 are fully autonomous and locally verifiable.
